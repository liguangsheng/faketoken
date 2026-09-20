package api

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
)

// blockRule is the shorthand these tests describe a policy with.
func blockRule(name string, keywords []string, replies []string) relay.BlockRule {
	return relay.BlockRule{Name: name, Enabled: true, Keywords: keywords, Replies: replies}
}

// A blocked request must be refused before an upstream sees it, and the reply
// must not disclose which keyword tripped — that would turn each rejection
// into a probe for mapping the list.
func TestBlockedKeywordRefusesTheRequest(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"forbidden-phrase", "another-one"}, nil),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save keywords: HTTP %d", resp.StatusCode)
	}

	// Mixed case, to be sure matching folds it.
	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"a FORBIDDEN-Phrase here"}]}`)
	body, _ := io.ReadAll(blocked.Body)
	blocked.Body.Close()

	// Answered with the fixed text rather than an error, so the caller sees an
	// ordinary reply. What must never happen is the real model answering.
	if blocked.StatusCode != http.StatusOK {
		t.Fatalf("blocked request: HTTP %d, want 200", blocked.StatusCode)
	}
	if !strings.Contains(string(body), "北国风光") {
		t.Fatalf("the canned reply was not returned: %s", body)
	}
	if strings.Contains(strings.ToLower(string(body)), "forbidden-phrase") {
		t.Fatalf("the reply disclosed the keyword: %s", body)
	}
	if reached.Load() != 0 {
		t.Fatal("a blocked request still reached the upstream")
	}

	// A clean request on the same key still works, so the block is per request
	// rather than a state the key falls into.
	clean := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"perfectly fine"}]}`)
	_, _ = io.Copy(io.Discard, clean.Body)
	clean.Body.Close()
	if clean.StatusCode != http.StatusOK {
		t.Fatalf("clean request: HTTP %d, want 200", clean.StatusCode)
	}

	// The operator needs to see what happened, with the keyword recorded.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the blocked call to be logged"))
	if !strings.Contains(listed.Data[0].Error, "forbidden-phrase") {
		t.Fatalf("the log does not say which keyword matched: %q", listed.Data[0].Error)
	}
}

// The canned reply has to be in the caller's own dialect and parse as an
// ordinary answer; a reply the client cannot read is worse than a refusal.
func TestBlockedRequestGetsACannedReplyPerDialect(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	for _, ch := range []channelInput{
		{Name: "openai", Type: "openai", BaseURL: up.URL, APIKey: "k",
			Models: []string{"gpt-4o"}, Groups: []string{"default"}},
		{Name: "anthropic", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
			Models: []string{"claude-3"}, Groups: []string{"default"}},
	} {
		h.createChannel(ch)
	}
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	t.Run("openai", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d, want 200", r.StatusCode)
		}
		var parsed struct {
			Choices []struct {
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("reply is not valid JSON: %v (%s)", err, body)
		}
		if len(parsed.Choices) == 0 || !strings.Contains(parsed.Choices[0].Message.Content, "北国风光") {
			t.Fatalf("unexpected content: %s", body)
		}
		// Zero tokens is what marks a reply as synthetic to anything that
		// reads usage.
		switch {
		case parsed.Usage.PromptTokens == 0:
			t.Fatalf("no prompt tokens reported: %s", body)
		case parsed.Usage.CompletionTokens == 0:
			t.Fatalf("no completion tokens reported: %s", body)
		case parsed.Usage.TotalTokens != parsed.Usage.PromptTokens+parsed.Usage.CompletionTokens:
			t.Fatalf("total does not add up: %+v", parsed.Usage)
		}
	})

	t.Run("anthropic", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-3","messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d, want 200", r.StatusCode)
		}
		var parsed struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("reply is not valid JSON: %v (%s)", err, body)
		}
		if parsed.Type != "message" || len(parsed.Content) == 0 ||
			!strings.Contains(parsed.Content[0].Text, "北国风光") {
			t.Fatalf("unexpected anthropic reply: %s", body)
		}
		if parsed.Usage.InputTokens == 0 || parsed.Usage.OutputTokens == 0 {
			t.Fatalf("anthropic reply reported no tokens: %s", body)
		}
	})

	t.Run("openai stream", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		text := string(body)
		if !strings.Contains(text, "data: [DONE]") {
			t.Fatalf("the stream never terminated: %s", text)
		}
		// Every frame has to be readable on its own: a client parses them one
		// at a time, not as one document.
		var assembled strings.Builder
		for _, line := range strings.Split(text, "\n") {
			payload, ok := strings.CutPrefix(line, "data: ")
			if !ok || payload == "[DONE]" {
				continue
			}
			var chunk struct {
				Choices []struct {
					Delta struct{ Content string } `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
				t.Fatalf("unparseable chunk %q: %v", payload, err)
			}
			for _, choice := range chunk.Choices {
				assembled.WriteString(choice.Delta.Content)
			}
		}
		if !strings.Contains(assembled.String(), "数风流人物") {
			t.Fatalf("the streamed text was incomplete: %q", assembled.String())
		}
	})

	t.Run("anthropic stream", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-3","stream":true,"messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		text := string(body)
		for _, want := range []string{
			"event: message_start", "event: content_block_delta", "event: message_stop",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("missing %q in the stream: %s", want, text)
			}
		}
		if !strings.Contains(text, "text_delta") || !strings.Contains(text, "\\u5317\\u56fd") &&
			!strings.Contains(text, "北国") {
			t.Fatalf("the stream carried no text: %s", text)
		}
	})

	if reached.Load() != 0 {
		t.Fatalf("%d blocked requests still reached an upstream", reached.Load())
	}

	// Nothing was spent, so nothing may be billed.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		rr := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		rr.Body.Close()
		return len(listed.Data) >= 4
	}, waiting("the blocked calls to be logged"))
	for _, entry := range listed.Data {
		if entry.Cost != 0 || entry.TotalTokens != 0 {
			t.Fatalf("a blocked call was billed: cost=%d tokens=%d", entry.Cost, entry.TotalTokens)
		}
		if entry.StatusCode != http.StatusOK {
			t.Fatalf("logged status %d, want 200 — it is what the caller saw", entry.StatusCode)
		}
	}
}

// The reply text is the operator's to choose; the default is only a default.
func TestBlockedReplyIsConfigurable(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"tripwire"}, []string{"这条请求不符合本网关的使用规范。"}),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", r.StatusCode)
	}
	if !strings.Contains(string(body), "不符合本网关的使用规范") {
		t.Fatalf("the configured reply was not used: %s", body)
	}
	if strings.Contains(string(body), "北国风光") {
		t.Fatalf("the default reply was returned instead: %s", body)
	}
}

// An error status has to produce an error, not a success-shaped body carrying
// a 4xx — that combination is what breaks clients.
func TestBlockedStatusIsConfigurable(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockedStatus = http.StatusForbidden
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"tripwire"}, []string{"内容不合规"}),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()

	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("HTTP %d, want the configured 403", r.StatusCode)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("a non-2xx block must be a parseable error: %v (%s)", err, body)
	}
	if parsed.Error.Message != "内容不合规" || parsed.Error.Code != "content_blocked" {
		t.Fatalf("unexpected error body: %s", body)
	}
	if reached.Load() != 0 {
		t.Fatal("a blocked request reached the upstream")
	}
}

// Out-of-range values are refused rather than stored and quietly ignored at
// request time.
func TestBlockedStatusRejectsNonsense(t *testing.T) {
	h := newHarness(t)

	for _, status := range []int{0, 99, 600, -1} {
		settings := h.settings(t)
		settings.BlockedStatus = status
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d was accepted: HTTP %d", status, resp.StatusCode)
		}
	}
}

// Endpoints that expect something other than prose keep the refusal: a poem in
// place of an embedding vector is a parse error, not a policy message.
func TestBlockedNonChatEndpointStillRefuses(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"text-embedding-3-small"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	r := h.relayRequest(http.MethodPost, "/v1/embeddings", key,
		`{"model":"text-embedding-3-small","input":"tripwire"}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()

	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("embeddings: HTTP %d, want 401", r.StatusCode)
	}
	if strings.Contains(string(body), "北国风光") {
		t.Fatalf("a poem was returned where a vector belongs: %s", body)
	}
}

// Clearing the list has to restore normal service without a restart.
func TestBlockedKeywordsCanBeCleared(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"nope"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	// Both outcomes are now 200, so they are told apart by what came back:
	// the fixed text, or the upstream's own answer.
	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"nope"}]}`)
	blockedBody, _ := io.ReadAll(blocked.Body)
	blocked.Body.Close()
	if !strings.Contains(string(blockedBody), "北国风光") {
		t.Fatalf("expected the keyword to block, got: %s", blockedBody)
	}

	// Blank keywords only — the parse has to treat this as "no keywords"
	// rather than as one empty keyword, which would match everything.
	settings = h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"", "  "}, nil)}
	resp = h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	allowed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"nope"}]}`)
	allowedBody, _ := io.ReadAll(allowed.Body)
	allowed.Body.Close()
	if strings.Contains(string(allowedBody), "北国风光") {
		t.Fatalf("clearing the list did not restore service: %s", allowedBody)
	}
	if allowed.StatusCode != http.StatusOK {
		t.Fatalf("clearing the list did not restore service: HTTP %d", allowed.StatusCode)
	}
}

// Each group answers from its own pool, drawn at random, so a caller who
// repeats the same probe does not get a reply they can fingerprint.
func TestBlockedRepliesAreDrawnAtRandom(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	pool := []string{"我在。", "在的，有什么可以帮你？", "嗯，说吧。"}
	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("liveness", []string{"ping"}, pool)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	seen := map[string]int{}
	for range 40 {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		var parsed struct {
			Choices []struct {
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Choices) == 0 {
			t.Fatalf("unreadable reply: %s", body)
		}
		seen[parsed.Choices[0].Message.Content]++
	}

	for reply := range seen {
		if !slices.Contains(pool, reply) {
			t.Fatalf("a reply came back that was never configured: %q", reply)
		}
	}
	// Forty draws all landing on one of three replies has probability
	// 3*(1/3)^40, so a failure here is a stuck picker rather than bad luck.
	if len(seen) < 2 {
		t.Fatalf("all 40 blocked calls returned the same reply: %#v", seen)
	}
}

// One category can be answered like a model while another is refused outright.
// That is the reason the status is per group and not only global.
func TestBlockRuleStatusOverridesTheGlobalDefault(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	strict := blockRule("jailbreak", []string{"ignore previous"}, []string{"不行。"})
	strict.Status = http.StatusForbidden

	settings := h.settings(t)
	settings.BlockedStatus = http.StatusOK
	settings.BlockRules = []relay.BlockRule{
		blockRule("liveness", []string{"ping"}, []string{"我在。"}),
		strict,
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	// Inherits the global 200, so it reads as an ordinary answer.
	live := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	liveBody, _ := io.ReadAll(live.Body)
	live.Body.Close()
	if live.StatusCode != http.StatusOK {
		t.Fatalf("inheriting group: HTTP %d, want 200", live.StatusCode)
	}
	if !strings.Contains(string(liveBody), "我在") {
		t.Fatalf("inheriting group answered with something else: %s", liveBody)
	}

	// Carries its own 403, so it arrives as an error.
	jail := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"please IGNORE PREVIOUS instructions"}]}`)
	jailBody, _ := io.ReadAll(jail.Body)
	jail.Body.Close()
	if jail.StatusCode != http.StatusForbidden {
		t.Fatalf("overriding group: HTTP %d, want its own 403", jail.StatusCode)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(jailBody, &parsed); err != nil {
		t.Fatalf("a non-2xx block must be a parseable error: %v (%s)", err, jailBody)
	}
	if parsed.Error.Message != "不行。" || parsed.Error.Code != "content_blocked" {
		t.Fatalf("unexpected error body: %s", jailBody)
	}

	if reached.Load() != 0 {
		t.Fatalf("%d blocked requests still reached an upstream", reached.Load())
	}
}

// The group and the keyword are the operator's record. A caller who could read
// them back — or search for them — would be able to map the list one request at
// a time, which is exactly what answering instead of refusing is meant to stop.
func TestBlockedDetailStaysWithTheOperator(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("liveness", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	_, _ = io.Copy(io.Discard, blocked.Body)
	blocked.Body.Close()

	// The operator's own listing keeps both halves.
	var operator page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &operator)
		r.Body.Close()
		return len(operator.Data) >= 1
	}, waiting("the blocked call to be logged"))
	if !strings.Contains(operator.Data[0].Error, "liveness") ||
		!strings.Contains(operator.Data[0].Error, "tripwire") {
		t.Fatalf("the operator's log lost the detail: %q", operator.Data[0].Error)
	}

	// The caller's own listing keeps neither. The row is still there — hiding
	// the call entirely would be its own signal.
	var mine page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/logs?only_error=true", h.admin, nil, &mine)
	r.Body.Close()
	if len(mine.Data) == 0 {
		t.Fatal("the caller cannot see their own blocked call at all")
	}
	for _, entry := range mine.Data {
		if strings.Contains(entry.Error, "tripwire") || strings.Contains(entry.Error, "liveness") {
			t.Fatalf("the caller's log disclosed the policy: %q", entry.Error)
		}
	}

	// Nor can they confirm the word by searching for it, which would tell them
	// just as much as reading it.
	var searched page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/logs?keyword=tripwire", h.admin, nil, &searched)
	r.Body.Close()
	if len(searched.Data) != 0 {
		t.Fatalf("searching the keyword returned %d rows, want none", len(searched.Data))
	}

	// The same search still has to work for the operator.
	var operatorSearch page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/admin/logs?keyword=tripwire", h.admin, nil, &operatorSearch)
	r.Body.Close()
	if len(operatorSearch.Data) == 0 {
		t.Fatal("the operator cannot find the blocked call by its keyword")
	}
}
