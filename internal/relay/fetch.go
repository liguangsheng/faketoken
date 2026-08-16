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
	adaptor := provider.For(ch.Type)
	baseURL := ch.BaseURL
	if baseURL == "" {
		baseURL = adaptor.DefaultBaseURL()
	}

	req, err := adaptor.ModelsRequest(baseURL, ch.APIKey)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	req = req.WithContext(ctx)
	for k, v := range ch.Headers {
		req.Header.Set(k, v)
	}

	client, err := rl.clients.get(ch.ProxyURL)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request upstream model list: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream returned HTTP %d: %s",
			resp.StatusCode, upstreamErrorMessage(body))
	}

	models, err := adaptor.ParseModels(body)
	if err != nil {
		return nil, err
	}
	sort.Strings(models)
	return dedupe(models), nil
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
	Model string
	// Prompt makes this a real inference request. It costs real upstream
	// tokens, so it is never the default.
	Prompt string
}

// TestChannel sends the smallest possible completion so an operator can verify
// credentials, routing and model mapping in one click.
func (rl *Relay) TestChannel(ctx context.Context, ch *model.Channel, testModel string) TestResult {
	return rl.TestChannelWith(ctx, ch, TestOptions{Model: testModel})
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

	adaptor := provider.For(ch.Type)
	baseURL := ch.BaseURL
	if baseURL == "" {
		baseURL = adaptor.DefaultBaseURL()
	}

	prompt := strings.TrimSpace(opts.Prompt)
	path, payload := probeRequest(ch.Type, upstreamModel, prompt)
	limit := rl.captureLimit()
	requestBody, requestTruncated := sanitizeBody("application/json", payload, false, limit)
	detail := model.RequestLogDetail{
		RequestBody:      requestBody,
		RequestTruncated: requestTruncated,
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		provider.JoinURL(baseURL, path), bytes.NewReader(payload))
	if err != nil {
		return TestResult{Model: testModel, UpstreamModel: upstreamModel,
			Endpoint: path, Message: err.Error(), Detail: detail}
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range ch.Headers {
		req.Header.Set(k, v)
	}
	adaptor.ApplyAuth(req, ch.APIKey)
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
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

// probeBodyLimit caps what a probe reads back. A probe asks for at most 1024
// tokens, so anything beyond this is a misbehaving upstream rather than an
// answer worth storing.
const probeBodyLimit = 256 << 10

// probeRequest builds the smallest request that answers the question being
// asked: without a prompt one token is enough to prove the credential works,
// while a prompted probe needs room for a real reply.
func probeRequest(channelType, modelName, prompt string) (string, []byte) {
	maxTokens := 1
	text := "hi"
	if prompt != "" {
		// Bounded on purpose: every probe spends the operator's own money, and
		// the templates all ask for short answers.
		maxTokens = 1024
		text = prompt
	}

	switch strings.ToLower(channelType) {
	case model.ChannelAnthropic:
		payload, _ := json.Marshal(map[string]any{
			"model":      modelName,
			"max_tokens": maxTokens,
			"messages":   []map[string]string{{"role": "user", "content": text}},
		})
		return "/v1/messages", payload
	case model.ChannelGemini:
		payload, _ := json.Marshal(map[string]any{
			"contents": []map[string]any{
				{"parts": []map[string]string{{"text": text}}},
			},
			"generationConfig": map[string]any{"maxOutputTokens": maxTokens},
		})
		return "/v1beta/models/" + modelName + ":generateContent", payload
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
