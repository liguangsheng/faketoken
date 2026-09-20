package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
)

// FetchModels pulls the upstream model catalogue for a channel.
func (rl *Relay) FetchModels(ctx context.Context, ch *model.Channel) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()

	client, err := rl.clients.get(ch.ProxyURL)
	if err != nil {
		return nil, err
	}

	var lastErr error
	for _, attempt := range modelListAttempts(ch) {
		target := provider.JoinURL(ch.BaseURL, attempt.path) + attempt.query
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return nil, err
		}
		provider.ApplyAuth(req, ch.APIKey, attempt.authStyle)
		for k, v := range ch.Headers {
			req.Header.Set(k, v)
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("request upstream model list: %w", err)
			if ctx.Err() != nil {
				break
			}
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("upstream returned HTTP %d: %s",
				resp.StatusCode, upstreamErrorMessage(body))
			continue
		}

		models, err := provider.ParseModels(body)
		if err != nil {
			lastErr = err
			continue
		}
		if len(models) == 0 {
			lastErr = fmt.Errorf("upstream response did not contain model ids")
			continue
		}
		sort.Strings(models)
		return dedupe(models), nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no model-list request could be built")
	}
	return nil, lastErr
}

type modelListAttempt struct {
	path      string
	query     string
	authStyle string
}

// modelListAttempts keeps auto useful for direct Anthropic and Gemini APIs,
// whose catalogue endpoint cannot reveal its authentication style until a
// request is made. Hints only change the order; all three standard forms are
// still tried within one shared timeout.
func modelListAttempts(ch *model.Channel) []modelListAttempt {
	style := strings.ToLower(strings.TrimSpace(ch.AuthStyle))
	build := func(value string) modelListAttempt {
		if value == model.AuthStyleXGoogAPIKey {
			return modelListAttempt{path: "/v1beta/models", query: "?pageSize=1000", authStyle: value}
		}
		query := ""
		if value == model.AuthStyleXAPIKey {
			query = "?limit=1000"
		}
		return modelListAttempt{path: "/v1/models", query: query, authStyle: value}
	}
	if style != "" && style != model.AuthStyleAuto {
		return []modelListAttempt{build(style)}
	}

	order := []string{model.AuthStyleBearer, model.AuthStyleXAPIKey, model.AuthStyleXGoogAPIKey}
	hint := strings.ToLower(ch.BaseURL + " " + ch.APIKey)
	switch {
	case strings.Contains(hint, "anthropic") || strings.HasPrefix(ch.APIKey, "sk-ant-"):
		order = []string{model.AuthStyleXAPIKey, model.AuthStyleBearer, model.AuthStyleXGoogAPIKey}
	case strings.Contains(hint, "googleapis") || strings.HasPrefix(ch.APIKey, "AIza"):
		order = []string{model.AuthStyleXGoogAPIKey, model.AuthStyleBearer, model.AuthStyleXAPIKey}
	}
	attempts := make([]modelListAttempt, 0, len(order))
	for _, candidate := range order {
		attempts = append(attempts, build(candidate))
	}
	return attempts
}

// TestResult reports a single channel probe.
type TestResult struct {
	OK        bool   `json:"ok"`
	Model     string `json:"model"`
	LatencyMS int64  `json:"latency_ms"`
	Status    int    `json:"status"`
	Message   string `json:"message"`
	// Prompt and Reply are only filled for a prompted probe, so the operator
	// can judge whether the channel returns a usable answer rather than just a
	// 200. Usage comes straight from the upstream's own accounting.
	Prompt string      `json:"prompt,omitempty"`
	Reply  string      `json:"reply,omitempty"`
	Usage  model.Usage `json:"usage,omitempty"`
	// UpstreamModel and Endpoint describe where the probe actually went, so a
	// caller can record it the same way a relayed request is recorded.
	UpstreamModel string `json:"upstream_model,omitempty"`
	Endpoint      string `json:"endpoint,omitempty"`
	// Detail carries the sanitised bodies for the request log. Kept out of the
	// JSON: the console already shows the reply, and shipping the raw exchange
	// back to the browser on every probe would be payload for nothing.
	Detail model.RequestLogDetail `json:"-"`
}

// TestOptions selects what a probe sends. The zero value keeps the original
// behaviour: a one-token request that only proves the credential works.
type TestOptions struct {
	Model    string
	Protocol string
	// Prompt makes this a real inference request. It costs real upstream
	// tokens, so it is never the default.
	Prompt string
}

// TestChannel sends the smallest possible completion so an operator can verify
// credentials, routing and model mapping in one click.
func (rl *Relay) TestChannel(ctx context.Context, ch *model.Channel, testModel string) TestResult {
	return rl.TestChannelWith(ctx, ch, TestOptions{Model: testModel, Protocol: model.ProtocolChatCompletions})
}

// TestChannelWith runs a probe, optionally carrying a prompt.
func (rl *Relay) TestChannelWith(ctx context.Context, ch *model.Channel, opts TestOptions) TestResult {
	testModel := opts.Model
	// Explicit request wins, then the channel's configured probe model. Falling
	// back to the first served model is a last resort: it is arbitrary, and a
	// prefix-only channel has no served model at all.
	if testModel == "" {
		testModel = strings.TrimSpace(ch.TestModel)
	}
	if testModel == "" && len(ch.Models) > 0 {
		testModel = ch.Models[0]
	}
	if testModel == "" {
		return TestResult{Message: "no test model: set one on the channel or pass it explicitly"}
	}
	upstreamModel := ch.UpstreamModel(testModel)

	prompt := strings.TrimSpace(opts.Prompt)
	path, payload := probeRequest(normaliseTestProtocol(opts.Protocol), upstreamModel, prompt)
	limit := rl.captureLimit()
	requestBody, requestTruncated := sanitizeBody("application/json", payload, false, limit)
	detail := model.RequestLogDetail{
		RequestBody:      requestBody,
		RequestTruncated: requestTruncated,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		provider.JoinURL(ch.BaseURL, path), bytes.NewReader(payload))
	if err != nil {
		return TestResult{Model: testModel, UpstreamModel: upstreamModel,
			Endpoint: path, Message: err.Error(), Detail: detail}
	}
	req.Header.Set("Content-Type", "application/json")
	provider.ApplyAuth(req, ch.APIKey, ch.AuthStyle)
	for k, v := range ch.Headers {
		req.Header.Set(k, v)
	}
	// Captured after the credential is applied so the log shows the request as
	// it was actually sent; sanitizeHeaders is what keeps the key out.
	detail.RequestHeaders = sanitizeHeaders(req.Header)

	client, err := rl.clients.get(ch.ProxyURL)
	if err != nil {
		return TestResult{Model: testModel, UpstreamModel: upstreamModel,
			Endpoint: path, Message: err.Error(), Detail: detail}
	}

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return TestResult{Model: testModel, UpstreamModel: upstreamModel, Endpoint: path,
			LatencyMS: time.Since(start).Milliseconds(), Message: err.Error(), Detail: detail}
	}
	defer resp.Body.Close()

	// One byte past the cap, so a body that fills it exactly can be told apart
	// from one that overflowed.
	body, _ := io.ReadAll(io.LimitReader(resp.Body, int64(probeBodyLimit)+1))
	overflowed := len(body) > probeBodyLimit
	if overflowed {
		body = body[:probeBodyLimit]
	}
	responseBody, responseTruncated := sanitizeBody(
		resp.Header.Get("Content-Type"), body, overflowed, limit)
	detail.ResponseHeaders = sanitizeHeaders(resp.Header)
	detail.ResponseBody = responseBody
	detail.ResponseTruncated = responseTruncated
	result := TestResult{
		Model:         testModel,
		UpstreamModel: upstreamModel,
		Endpoint:      path,
		LatencyMS:     time.Since(start).Milliseconds(),
		Status:        resp.StatusCode,
		OK:            resp.StatusCode >= 200 && resp.StatusCode < 300,
		Prompt:        prompt,
		Detail:        detail,
	}
	// Read for every probe, not just prompted ones: even a one-token
	// connectivity check spends the operator's money, and a log entry that
	// says zero tokens would be wrong rather than merely incomplete.
	if usage, ok := provider.ExtractUsage(body); ok {
		result.Usage = usage
	}
	if !result.OK {
		result.Message = upstreamErrorMessage(body)
		if result.Message == "" {
			result.Message = fmt.Sprintf("upstream returned HTTP %d", resp.StatusCode)
		}
		return result
	}

	if prompt != "" {
		result.Reply = extractReply(body)
		// A 200 carrying no text is a real failure mode: some gateways answer
		// with an empty choice rather than an error status.
		if result.Reply == "" {
			result.OK = false
			result.Message = "上游返回 200，但响应中没有可读的回复内容"
		}
	}
	return result
}

// extractReply pulls the assistant's text out of any of the three dialects.
func extractReply(body []byte) string {
	var payload struct {
		// OpenAI chat completions.
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
			Text string `json:"text"`
		} `json:"choices"`
		// Anthropic messages.
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		// Gemini generateContent.
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		// OpenAI Responses.
		Output []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		OutputText string `json:"output_text"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}

	for _, choice := range payload.Choices {
		if choice.Message.Content != "" {
			return choice.Message.Content
		}
		if choice.Text != "" {
			return choice.Text
		}
	}

	var parts []string
	for _, block := range payload.Content {
		if block.Type == "text" && block.Text != "" {
			parts = append(parts, block.Text)
		}
	}
	for _, candidate := range payload.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.Text != "" {
				parts = append(parts, part.Text)
			}
		}
	}
	if payload.OutputText != "" {
		parts = append(parts, payload.OutputText)
	}
	for _, item := range payload.Output {
		for _, content := range item.Content {
			if content.Text != "" {
				parts = append(parts, content.Text)
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// probeBodyLimit caps what a probe reads back. A probe asks for at most 1024
// tokens, so anything beyond this is a misbehaving upstream rather than an
// answer worth storing.
const probeBodyLimit = 256 << 10

// normaliseTestProtocol defaults an unspecified probe to chat completions,
// the dialect every compatible gateway answers.
func normaliseTestProtocol(protocol string) string {
	protocol = strings.TrimSpace(protocol)
	if protocol == "" {
		return model.ProtocolChatCompletions
	}
	return protocol
}

// probeRequest builds the smallest request that answers the question being
// asked: without a prompt one token is enough to prove the credential works,
// while a prompted probe needs room for a real reply.
func probeRequest(protocol, modelName, prompt string) (string, []byte) {
	maxTokens := 1
	text := "hi"
	if prompt != "" {
		// Bounded on purpose: every probe spends the operator's own money, and
		// the templates all ask for short answers.
		maxTokens = 1024
		text = prompt
	}

	switch protocol {
	case model.ProtocolMessages:
		payload, _ := json.Marshal(map[string]any{
			"model":      modelName,
			"max_tokens": maxTokens,
			"messages":   []map[string]string{{"role": "user", "content": text}},
		})
		return "/v1/messages", payload
	case model.ProtocolResponses:
		payload, _ := json.Marshal(map[string]any{
			"model": modelName, "input": text, "max_output_tokens": maxTokens,
		})
		return "/v1/responses", payload
	default:
		payload, _ := json.Marshal(map[string]any{
			"model":      modelName,
			"max_tokens": maxTokens,
			"messages":   []map[string]string{{"role": "user", "content": text}},
		})
		return "/v1/chat/completions", payload
	}
}

func dedupe(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, ok := seen[v]; ok {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}
