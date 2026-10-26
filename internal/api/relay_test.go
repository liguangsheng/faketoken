package api

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

func TestRelayPassesRequestThroughVerbatim(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "pong", 10, 4)
	})

	h.createChannel(channelInput{
		Name: "primary", Type: "openai", BaseURL: up.URL, APIKey: "upstream-secret",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Weight: 1,
	})

	key := h.createKey()
	reqBody := `{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}],"temperature":0.42,"custom_vendor_field":{"a":[1,2,3]}}`
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, reqBody)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	// The body must arrive byte-for-byte: unknown vendor fields included.
	if up.body() != reqBody {
		t.Errorf("body was modified:\n got: %s\nwant: %s", up.body(), reqBody)
	}
	// The caller's key must be replaced by the channel credential.
	if up.auth() != "Bearer upstream-secret" {
		t.Errorf("upstream saw Authorization %q", up.auth())
	}
	if up.path() != "/v1/chat/completions" {
		t.Errorf("upstream path = %q", up.path())
	}

	var answer struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatalf("bad response: %s", raw)
	}
	if len(answer.Choices) != 1 || answer.Choices[0].Message.Content != "pong" {
		t.Fatalf("unexpected response: %s", raw)
	}
}

func TestRelayForwardsClientHeadersButStripsCredentials(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "sk-upstream",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, _ := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o"}`))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Custom-Trace", "trace-123")
	req.Header.Set("OpenAI-Beta", "assistants=v2")
	req.Header.Set("Cookie", "session=leak-me")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	hdrs := up.headers()
	if got := hdrs.Get("X-Custom-Trace"); got != "trace-123" {
		t.Errorf("custom header lost: %q", got)
	}
	if got := hdrs.Get("OpenAI-Beta"); got != "assistants=v2" {
		t.Errorf("vendor header lost: %q", got)
	}
	if got := hdrs.Get("Cookie"); got != "" {
		t.Errorf("client cookie leaked upstream: %q", got)
	}
}

func TestChannelUserAgentLocksPerProtocolAndCanClear(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "ua-lock", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, LockUserAgent: true,
	})
	key := h.createKey()

	send := func(path, ua string, wantStatus int) {
		req, err := http.NewRequest(http.MethodPost, h.server.URL+path,
			strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", ua)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != wantStatus {
			t.Fatalf("%s with UA %q: HTTP %d, want %d", path, ua, resp.StatusCode, wantStatus)
		}
	}

	send("/v1/chat/completions", "chat-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "chat-first" {
		t.Fatalf("first chat User-Agent = %q", got)
	}
	channel, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got := channel.LockedUserAgents[model.ProtocolChatCompletions]; got != "chat-first" {
		t.Fatalf("successful chat request did not auto-lock UA: %q", got)
	}
	send("/v1/chat/completions", "chat-second", http.StatusOK)
	if got := up.requests.Load(); got != 2 {
		t.Fatalf("second request count=%d, want 2", got)
	}
	if got := up.headers().Get("User-Agent"); got != "chat-first" {
		t.Fatalf("locked chat User-Agent = %q, want chat-first", got)
	}

	send("/v1/messages", "messages-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "messages-first" {
		t.Fatalf("messages User-Agent = %q, want messages-first", got)
	}
	send("/v1/responses", "responses-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "responses-first" {
		t.Fatalf("responses User-Agent = %q, want responses-first", got)
	}

	clearURL := fmt.Sprintf("/api/admin/channels/%d/user-agent/clear?protocol=chat_completions", id)
	resp := h.do(http.MethodPost, clearURL, h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clear chat User-Agent: HTTP %d", resp.StatusCode)
	}
	send("/v1/chat/completions", "chat-third", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "chat-third" {
		t.Fatalf("relocked chat User-Agent = %q, want chat-third", got)
	}
}

func TestChannelUserAgentManualConfigOverridesHeadersWithoutAutoLocking(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "ua-manual", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers:          map[string]string{"User-Agent": "header-ua"},
		LockedUserAgents: map[string]string{model.ProtocolChatCompletions: "manual-ua"},
	})
	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("manual UA request: HTTP %d", resp.StatusCode)
	}
	if got := up.headers().Get("User-Agent"); got != "manual-ua" {
		t.Fatalf("upstream User-Agent = %q, want manual-ua", got)
	}
	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.LockUserAgent {
		t.Fatal("manual UA unexpectedly enabled automatic locking")
	}
	if got := ch.LockedUserAgents[model.ProtocolChatCompletions]; got != "manual-ua" {
		t.Fatalf("manual UA was not retained: %q", got)
	}
}

func TestChannelUserAgentAutoLockHappensOnlyAfterSuccess(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusBadRequest)
	})
	id := h.createChannel(channelInput{
		Name: "ua-auto-failure", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, LockUserAgent: true,
	})
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(),
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("failed auto-lock request: HTTP %d", resp.StatusCode)
	}
	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got := ch.LockedUserAgents[model.ProtocolChatCompletions]; got != "" {
		t.Fatalf("failed request auto-locked UA %q", got)
	}
}

func TestChannelCanRejectConversationAttachmentsBeforeUpstream(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "should not be reached", 1, 1)
	})
	allow := false
	h.createChannel(channelInput{
		Name: "text-only", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, AllowAttachments: &allow,
	})
	key := h.createKey()
	body := `{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}`
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("attachment request: HTTP %d, want 429: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "attachments_not_allowed") {
		t.Fatalf("unexpected attachment rejection: %s", raw)
	}
	if !strings.Contains(string(raw), "请求不能携带附件") {
		t.Fatalf("attachment rejection message is unclear: %s", raw)
	}
	if strings.Contains(string(raw), "text-only") || strings.Contains(string(raw), "channel") {
		t.Fatalf("attachment rejection leaked channel information: %s", raw)
	}
	if got := up.requests.Load(); got != 0 {
		t.Fatalf("attachment rejection reached upstream %d time(s)", got)
	}

	plain := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"plain text"}]}`)
	plain.Body.Close()
	if plain.StatusCode != http.StatusOK {
		t.Fatalf("plain text request: HTTP %d, want 200", plain.StatusCode)
	}
}

// A channel that refuses attachments is passed over, not the request: the next
// candidate that takes them gets it, and the refusing upstream never sees it.
func TestAttachmentRoutesPastChannelsThatRefuseIt(t *testing.T) {
	h := newHarness(t)
	textOnly := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "should not be reached", 1, 1)
	})
	vision := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "seen", 1, 1)
	})
	allow := false
	// The refusing channel outranks the accepting one, so the only way the
	// request reaches vision is by being routed past text-only.
	h.createChannel(channelInput{
		Name: "text-only", Type: "openai", BaseURL: textOnly.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100,
		AllowAttachments: &allow,
	})
	h.createChannel(channelInput{
		Name: "vision", Type: "openai", BaseURL: vision.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1,
	})
	body := `{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}`
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(), body)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("attachment request: HTTP %d, want 200: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "seen") {
		t.Fatalf("attachment request was not answered by the accepting channel: %s", raw)
	}
	if got := textOnly.requests.Load(); got != 0 {
		t.Fatalf("refusing channel was reached %d time(s)", got)
	}
	if got := vision.requests.Load(); got != 1 {
		t.Fatalf("accepting channel was reached %d time(s), want 1", got)
	}
}

func TestChannelHeadersOverrideGeneratedAuthentication(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "custom-auth", Type: "openai", BaseURL: up.URL, APIKey: "generated-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers: map[string]string{"Authorization": "Token channel-override"},
	})

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(),
		`{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}
	if got := up.auth(); got != "Token channel-override" {
		t.Fatalf("Authorization = %q, want the channel override", got)
	}
}

func TestRelayStreamsSSEAndBillsUsage(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"he"}}]}`,
			`{"choices":[{"delta":{"content":"llo"}}]}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})

	h.createChannel(channelInput{
		Name: "stream", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true}}`)
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "data: [DONE]") {
		t.Fatalf("stream was not relayed intact: %s", raw)
	}
	if !strings.Contains(string(raw), `"content":"llo"`) {
		t.Fatalf("stream content missing: %s", raw)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	// gpt-4o: $2.50/1M in, $10/1M out -> 1000*2.5 + 500*10 = 7500 micro-USD.
	entry := h.waitForLog(t, 1)
	if entry.PromptTokens != 1000 || entry.CompletionTokens != 500 {
		t.Fatalf("usage not captured from the stream: %+v", entry)
	}
	if entry.Cost != 7500 {
		t.Fatalf("cost = %d micro-USD, want 7500", entry.Cost)
	}
}

// A gateway under load answers 200 text/event-stream, pings a few times, then
// ends the stream with an error event. Scored on the status line that call looks
// perfect: no error text in the log, no failure against the channel, and the
// breaker keeps feeding an upstream that is refusing everything.
func TestRelayRecordsErrorsDeliveredInsideAStream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for range 2 {
			fmt.Fprint(w, "data: {\"type\":\"ping\"}\n\n")
			flusher.Flush()
		}
		fmt.Fprint(w, `data: {"error":{"message":"Concurrency limit exceeded for account, `+
			`please retry later","type":"rate_limit_error"},"type":"error"}`+"\n\n")
		flusher.Flush()
	})

	id := h.createChannel(channelInput{
		Name: "stream-error", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
		`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,`+
			`"messages":[{"role":"user","content":"hi"}]}`)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	// The response still goes through untouched: the client asked for this
	// upstream's bytes and the headers were sent long before the error arrived.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the upstream's 200 relayed verbatim", resp.StatusCode)
	}
	if !strings.Contains(string(raw), "Concurrency limit exceeded") {
		t.Fatalf("the error event was not relayed to the caller: %s", raw)
	}

	entry := h.waitForLog(t, 1)
	// A stream that ends in rate_limit_error is judged as the 429 it is, even
	// though the caller keeps the upstream's 200 and its bytes.
	if entry.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("logged status = %d, want 429 for a stream that ends in rate_limit_error",
			entry.StatusCode)
	}
	if !strings.Contains(entry.Error, "Concurrency limit exceeded") ||
		!strings.Contains(entry.Error, "rate_limit_error") {
		t.Fatalf("the in-stream failure was not logged: %q", entry.Error)
	}

	// Recorded against the channel, so the breaker benches it and the console
	// shows why. Without this the channel looks perfectly healthy.
	h.waitFor(t, "the in-stream failure to be recorded against the channel", func() bool {
		return h.channel(id).ErrorCount > 0
	})
	if last := h.channel(id).LastError; !strings.Contains(last, "Concurrency limit exceeded") {
		t.Fatalf("channel last_error = %q, want the upstream reason", last)
	}

	// The error filter is how an operator finds these at all.
	var listed struct {
		Data []*model.RequestLog `json:"data"`
	}
	if r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed); r.StatusCode != http.StatusOK {
		t.Fatalf("log list failed: %d", r.StatusCode)
	}
	if len(listed.Data) != 1 || listed.Data[0].ID != entry.ID {
		t.Fatalf("only_error did not surface the failed stream: %+v", listed.Data)
	}
}

// The same failure without SSE framing: a 200 whose JSON body is an error
// object. Same blind spot, same treatment.
func TestRelayRecordsErrorBodyBehindA200(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"error":{"code":429,"message":"Resource has been exhausted"}}`))
	})
	id := h.createChannel(channelInput{
		Name: "body-error", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the upstream's 200 relayed verbatim", resp.StatusCode)
	}

	entry := h.waitForLog(t, 1)
	if entry.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("logged status = %d, want the 429 the body names", entry.StatusCode)
	}
	if !strings.Contains(entry.Error, "Resource has been exhausted") ||
		!strings.Contains(entry.Error, "429") {
		t.Fatalf("the error body behind the 200 was not logged: %q", entry.Error)
	}
	h.waitFor(t, "the failure to be recorded against the channel", func() bool {
		return h.channel(id).ErrorCount > 0
	})
}

// A rate limit delivered inside a 200 stream is judged as the 429 it is: the
// caller keeps the upstream's bytes, but the log shows a rate limit and the
// partial usage it carried is not billed.
func TestRelayDoesNotBillAStreamThatEndsInRateLimit(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"par"}}]}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}`,
			`{"error":{"message":"Concurrency limit exceeded for account","type":"rate_limit_error"}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
	})
	h.createChannel(channelInput{
		Name: "stream-rate-limited", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true}}`)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the upstream's 200 relayed verbatim", resp.StatusCode)
	}
	if !strings.Contains(string(raw), "rate_limit_error") {
		t.Fatalf("the error event was not relayed to the caller: %s", raw)
	}

	entry := h.waitForLog(t, 1)
	if entry.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("logged status = %d, want 429 for a stream that ends in rate_limit_error",
			entry.StatusCode)
	}
	// Usage is kept for observability; the charge is not: a 429 is never billed.
	if entry.TotalTokens != 1500 {
		t.Fatalf("total tokens = %d, want the stream's usage captured", entry.TotalTokens)
	}
	if entry.Cost != 0 {
		t.Fatalf("cost = %d micro-USD, want a rate-limited stream not billed", entry.Cost)
	}
}

// The rewrite is for rate limits only: a stream that fails for another reason
// keeps the 200 it relayed, as before.
func TestRelayKeepsNonRateLimitStreamFailuresAsRelayed(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		fmt.Fprint(w, `data: {"error":{"message":"Overloaded","type":"overloaded_error"}}`+"\n\n")
		flusher.Flush()
	})
	h.createChannel(channelInput{
		Name: "stream-overloaded", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.StatusCode != http.StatusOK {
		t.Fatalf("logged status = %d, want the relayed 200 for a non-rate-limit failure",
			entry.StatusCode)
	}
	if !strings.Contains(entry.Error, "overloaded_error") {
		t.Fatalf("the in-stream failure was not logged: %q", entry.Error)
	}
}

// The caller that prompted all of this: an SDK stops reading the instant it
// sees [DONE] and drops the connection, while the upstream — anything behind a
// shared gateway tends to — holds its side open for another moment. The relay
// has the whole answer in hand, so the row has to read as the success it was
// instead of waiting for the winner of that race.
func TestRelayStreamEndsCleanlyWhenTheCallerLeavesAtDone(t *testing.T) {
	h := newHarness(t)

	release := make(chan struct{})
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"he"}}]}`,
			`{"choices":[{"delta":{"content":"llo"}}]}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
		// Nothing else is coming, but no end of body either.
		<-release
	})
	defer close(release)

	h.createChannel(channelInput{
		Name: "held-open", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true}}`)
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	var relayed strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("reading the stream: %v", err)
		}
		relayed.WriteString(line)
		if strings.Contains(line, "[DONE]") {
			break
		}
	}
	if !strings.Contains(relayed.String(), "llo") {
		t.Fatalf("stream content missing: %s", relayed.String())
	}
	// The caller is done: nothing after the marker is theirs to read.
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.Error != "" {
		t.Fatalf("a finished stream was logged as %q", entry.Error)
	}
	if entry.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the relayed 200", entry.StatusCode)
	}
	if entry.CompletionTokens != 500 {
		t.Fatalf("completion tokens = %d, want the usage the stream carried", entry.CompletionTokens)
	}
}

// The counterpart guard: an ordinary stream must not be scored as a failure,
// including when the model itself writes about errors.
func TestRelayLeavesHealthyStreamsUnflagged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"the error was a missing semicolon"}}],"error":null}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})
	id := h.createChannel(channelInput{
		Name: "healthy-stream", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.Error != "" {
		t.Fatalf("a healthy stream was logged as failed: %q", entry.Error)
	}
	if ch := h.channel(id); ch.ErrorCount != 0 {
		t.Fatalf("a healthy stream counted %d channel error(s)", ch.ErrorCount)
	}
}

func TestModelMappingRewritesOnlyTheModelField(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "mapped", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models:       []string{"gpt-4o"},
		ModelMapping: map[string]string{"gpt-4o": "gpt-4o-2024-11-20"},
		Groups:       []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[],"seed":12345678901234567890}`)
	resp.Body.Close()

	want := `{"model":"gpt-4o-2024-11-20","messages":[],"seed":12345678901234567890}`
	if up.body() != want {
		t.Fatalf("mapping mangled the payload:\n got: %s\nwant: %s", up.body(), want)
	}
}

func TestPriorityRoutingAndFailover(t *testing.T) {
	h := newHarness(t)

	broken := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"message":"upstream on fire"}}`, http.StatusInternalServerError)
	})
	healthy := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "recovered", 2, 3)
	})

	h.createChannel(channelInput{
		Name: "high-priority-broken", Type: "openai", BaseURL: broken.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100,
	})
	h.createChannel(channelInput{
		Name: "fallback", Type: "openai", BaseURL: healthy.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1,
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("failover did not happen: HTTP %d %s", resp.StatusCode, raw)
	}
	if broken.requests.Load() != 1 {
		t.Errorf("the high-priority channel should have been tried first, got %d calls",
			broken.requests.Load())
	}
	if healthy.requests.Load() != 1 {
		t.Errorf("the fallback channel should have served the request, got %d calls",
			healthy.requests.Load())
	}
}

func TestClientErrorsAreNotRetriedAndPassThrough(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"unknown parameter: foo","type":"invalid_request_error"}}`)
	})
	h.createChannel(channelInput{
		Name: "a", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "b", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o","foo":1}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want the upstream 400 verbatim", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "unknown parameter: foo") {
		t.Fatalf("upstream error body was not passed through: %s", raw)
	}
	if up.requests.Load() != 1 {
		t.Fatalf("a 400 must not be retried, got %d attempts", up.requests.Load())
	}
}

func TestAuthenticationFailuresDoNotAutoDisableAChannel(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"bad upstream key"}}`)
	})
	id := h.createChannel(channelInput{
		Name: "keeps-running", BaseURL: up.URL, APIKey: "wrong-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	for attempt := 0; attempt < 3; attempt++ {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
		resp.Body.Close()
	}
	channel, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if channel.Status != model.StatusEnabled {
		t.Fatalf("channel status = %d after authentication failures, want enabled", channel.Status)
	}
}

func TestAnthropicAndGeminiDialects(t *testing.T) {
	h := newHarness(t)

	anthropicUp := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":  "message",
			"usage": map[string]int{"input_tokens": 100, "output_tokens": 50},
		})
	})
	geminiUp := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"usageMetadata": map[string]int{
				"promptTokenCount": 20, "candidatesTokenCount": 8, "totalTokenCount": 28,
			},
		})
	})

	h.createChannel(channelInput{
		// Deliberately wrong legacy types: the client endpoint, not this field,
		// must select authentication for relayed requests.
		Name: "anthropic", Type: "openai", BaseURL: anthropicUp.URL, APIKey: "ant-key",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "gemini", Type: "anthropic", BaseURL: geminiUp.URL, APIKey: "goog-key",
		Models:       []string{"gemini-2.5-pro"},
		ModelMapping: map[string]string{"gemini-2.5-pro": "gemini-2.5-pro-preview"},
		Groups:       []string{"default"},
	})
	key := h.createKey()

	t.Run("anthropic uses x-api-key", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-sonnet-4-5","max_tokens":16}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d", resp.StatusCode)
		}
		hdrs := anthropicUp.headers()
		if got := hdrs.Get("X-Api-Key"); got != "ant-key" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := hdrs.Get("Authorization"); got != "" {
			t.Errorf("the caller's bearer token leaked upstream: %q", got)
		}
		if got := hdrs.Get("Anthropic-Version"); got == "" {
			t.Error("anthropic-version header was not supplied")
		}
	})

	t.Run("anthropic count_tokens uses the same path-derived auth", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost, "/v1/messages/count_tokens", key,
			`{"model":"claude-sonnet-4-5","messages":[]}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(resp.Body)
			t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
		}
		hdrs := anthropicUp.headers()
		if got := hdrs.Get("X-Api-Key"); got != "ant-key" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := hdrs.Get("Authorization"); got != "" {
			t.Errorf("the caller's bearer token leaked upstream: %q", got)
		}
	})

	t.Run("gemini maps the model in the path", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost,
			"/v1beta/models/gemini-2.5-pro:generateContent", key, `{"contents":[]}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d", resp.StatusCode)
		}
		if got := geminiUp.path(); got != "/v1beta/models/gemini-2.5-pro-preview:generateContent" {
			t.Errorf("path = %q, want the mapped model", got)
		}
		if got := geminiUp.headers().Get("X-Goog-Api-Key"); got != "goog-key" {
			t.Errorf("x-goog-api-key = %q", got)
		}
	})
}

// Gemini SDKs authenticate with ?key=..., so the relay must accept the key
// there — and must never forward it to the upstream.
func TestGeminiQueryKeyIsAcceptedButNeverForwarded(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}`)
	})
	h.createChannel(channelInput{
		Name: "gemini", Type: "gemini", BaseURL: up.URL, APIKey: "goog-key",
		Models: []string{"gemini-2.5-flash"}, Groups: []string{"default"},
	})
	key := h.createKey()

	target := fmt.Sprintf("%s/v1beta/models/gemini-2.5-flash:generateContent?key=%s&alt=sse",
		h.server.URL, key)
	req, _ := http.NewRequest(http.MethodPost, target, strings.NewReader(`{"contents":[]}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("query-string auth was rejected: HTTP %d %s", resp.StatusCode, raw)
	}
	if strings.Contains(up.path(), "key=") {
		t.Fatalf("the caller's relay key leaked to the upstream: %s", up.path())
	}
	if !strings.Contains(up.path(), "alt=sse") {
		t.Errorf("unrelated query parameters must survive: %s", up.path())
	}
	if got := up.headers().Get("X-Goog-Api-Key"); got != "goog-key" {
		t.Errorf("upstream credential = %q, want the channel key", got)
	}
}

func TestModelListingReflectsChannelsAndGroups(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "public", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o", "gpt-4o-mini"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "vip-only", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"o3-pro"}, Groups: []string{"vip"},
	})

	key := h.createKey()
	req, _ := http.NewRequest(http.MethodGet, h.server.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var listing struct {
		Data []struct{ ID string } `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, m := range listing.Data {
		got[m.ID] = true
	}
	if !got["gpt-4o"] || !got["gpt-4o-mini"] {
		t.Errorf("default group models missing: %v", got)
	}
	if got["o3-pro"] {
		t.Error("a model from another group leaked into the listing")
	}
}

func TestQuotaEnforcementAndSettlement(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1_000_000, 0) // $2.50 worth of gpt-4o input
	})
	h.createChannel(channelInput{
		Name: "expensive", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// A fresh user starts with $1.00.
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "spender", Password: "password123"}, &session)

	var created struct {
		Key string `json:"key"`
	}
	h.do(http.MethodPost, "/api/tokens", session.Token,
		tokenInput{Name: "k", UnlimitedQuota: true}, &created)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first request should succeed, got %d", resp.StatusCode)
	}

	h.waitForLog(t, 1)
	h.waitFor(t, "balance to go negative", func() bool {
		user, err := h.store.GetUser(context.Background(), session.User.ID)
		return err == nil && user.Quota <= 0
	})

	// The overspent account must be locked out of further requests.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key, `{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 once the balance is exhausted", resp.StatusCode)
	}
}

func TestUnknownModelIsRejected(t *testing.T) {
	h := newHarness(t)
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"nope"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestRelayRejectsBadKeys(t *testing.T) {
	h := newHarness(t)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", "sk-nonsense", `{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestPrefixRoutingOnlyAppliesWhenNoExactChannelMatches(t *testing.T) {
	h := newHarness(t)

	exact := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-exact", 1, 1)
	})
	prefix := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-prefix", 1, 1)
	})

	h.createChannel(channelInput{
		Name: "exact", Type: "openai", BaseURL: exact.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "prefix", Type: "openai", BaseURL: prefix.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// An explicitly listed model must never be stolen by a catch-all prefix.
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(raw), "from-exact") {
		t.Fatalf("prefix channel stole an exact match: %s", raw)
	}

	// A model nobody lists falls through to the prefix channel.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4.1-mini"}`)
	raw, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), "from-prefix") {
		t.Fatalf("prefix route did not answer: HTTP %d %s", resp.StatusCode, raw)
	}

	// A model outside every prefix still has no route.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"claude-sonnet-4"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unrelated model status = %d, want 404", resp.StatusCode)
	}
}

func TestDisabledChannelDropsOutOfPrefixRouting(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "prefix", Type: "openai", BaseURL: up.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, Groups: []string{"default"},
	})
	key := h.createKey()

	h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id), h.admin,
		map[string]any{"status": 2}, nil)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4.1"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a disabled channel still served a prefix route: HTTP %d", resp.StatusCode)
	}
}

// pinnedRequest is relayRequest with the channel pin set.
func (h *harness) pinnedRequest(key, pin, body string) *http.Response {
	h.t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions", strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("X-Faketoken-Channel", pin)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// A test aimed at one channel has to reach it, including a channel the ranking
// would never pick: a prefix channel always loses to an exact match, and this
// one also sits outside the key's group.
func TestAdminPinReachesTheNamedChannel(t *testing.T) {
	h := newHarness(t)

	ranked := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-ranked", 1, 1)
	})
	pinned := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-pinned", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "ranked", BaseURL: ranked.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100,
	})
	pinnedID := h.createChannel(channelInput{
		Name: "pinned", BaseURL: pinned.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, Groups: []string{"vip"},
	})
	key := h.createKey()

	resp := h.pinnedRequest(key, fmt.Sprint(pinnedID), `{"model":"gpt-4o"}`)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), "from-pinned") {
		t.Fatalf("pin did not reach its channel: HTTP %d %s", resp.StatusCode, raw)
	}
	if ranked.requests.Load() != 0 {
		t.Fatalf("the ranked channel was tried despite the pin: %d calls", ranked.requests.Load())
	}
	if got := pinned.headers().Get("X-Faketoken-Channel"); got != "" {
		t.Fatalf("the pin leaked upstream: %q", got)
	}
}

// A pin that cannot be honoured is refused, never rerouted: answering from
// another channel would pass that channel's result off as the tested one's.
func TestAdminPinRefusesAChannelThatCannotServe(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "serves", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	otherID := h.createChannel(channelInput{
		Name: "other-model", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4"}, Groups: []string{"default"},
	})
	key := h.createKey()

	for _, probe := range []struct {
		pin    string
		status int
	}{
		{fmt.Sprint(otherID), http.StatusNotFound},
		{"99999", http.StatusNotFound},
		{"not-a-number", http.StatusBadRequest},
	} {
		resp := h.pinnedRequest(key, probe.pin, `{"model":"gpt-4o"}`)
		resp.Body.Close()
		if resp.StatusCode != probe.status {
			t.Errorf("pin %q: HTTP %d, want %d", probe.pin, resp.StatusCode, probe.status)
		}
	}
	if up.requests.Load() != 0 {
		t.Fatalf("a refused pin still reached an upstream: %d calls", up.requests.Load())
	}
}

// Pinning bypasses groups, so it belongs to administrators; anyone else's pin
// is refused outright rather than ignored.
func TestRegularUserCannotPinAChannel(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "a", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// Funded, so the refusal comes from the pin and not from the balance check
	// that runs before it.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "plain", "password": "password123", "quota_usd": 10,
	}, nil)
	session := h.login("plain", "password123")
	var created struct {
		Key string `json:"key"`
	}
	h.do(http.MethodPost, "/api/tokens", session,
		tokenInput{Name: "plain", UnlimitedQuota: true}, &created)

	resp := h.pinnedRequest(created.Key, fmt.Sprint(id), `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user's pin: HTTP %d, want 403", resp.StatusCode)
	}
	if up.requests.Load() != 0 {
		t.Fatalf("a regular user's pin reached the upstream: %d calls", up.requests.Load())
	}
}

// An upstream behind a shared gateway answers 200, sends message_start with
// zero usage, then gives up. The caller got nothing and will send it again;
// estimating the prompt here used to bill it like a call that answered.
func TestFailedStreamWithNoOutputIsNotBilled(t *testing.T) {
	h := newHarness(t)

	// Read by the upstream goroutine, flipped by the test between calls.
	var answer atomic.Bool
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		events := []string{
			"event: message_start\ndata: " + `{"type":"message_start","message":{"id":"msg_1","type":"message",` +
				`"role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}`,
		}
		if answer.Load() {
			events = append(events,
				"event: content_block_delta\ndata: "+`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}`,
				"event: message_delta\ndata: "+`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`,
				"event: message_stop\ndata: "+`{"type":"message_stop"}`)
		} else {
			events = append(events,
				"event: error\ndata: "+`{"type":"error","error":{"type":"overloaded_error","message":"Could not reach the provider."}}`)
		}
		for _, event := range events {
			fmt.Fprint(w, event+"\n\n")
			flusher.Flush()
		}
	})
	h.createChannel(channelInput{
		Name: "overloaded-gateway", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})
	key := h.createKey()
	send := func() {
		resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,`+
				`"messages":[{"role":"user","content":"a prompt long enough to estimate"}]}`)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	send()
	failed := h.waitForLog(t, 1)
	if !strings.Contains(failed.Error, "overloaded_error") {
		t.Fatalf("the in-stream failure was not logged: %q", failed.Error)
	}
	if failed.Cost != 0 || failed.PromptEstimated || failed.PromptTokens != 0 {
		t.Fatalf("a call that delivered nothing was billed: cost %d, prompt %d, estimated %v",
			failed.Cost, failed.PromptTokens, failed.PromptEstimated)
	}

	// The estimate itself still applies to a call that answered.
	answer.Store(true)
	send()
	answered := h.waitForLog(t, 2)
	if !answered.PromptEstimated || answered.PromptTokens == 0 || answered.Cost == 0 {
		t.Fatalf("a successful call lost its estimated prompt: cost %d, prompt %d, estimated %v",
			answered.Cost, answered.PromptTokens, answered.PromptEstimated)
	}
}

// The output count of an Anthropic stream arrives only with the closing
// message_delta, so a caller that leaves before it has the answer yet zero
// output tokens to show for it. It is billed for what it received, and the
// channel is not blamed for a caller walking away.
func TestCallerHangingUpAfterContentIsBilled(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, event := range []string{
			"event: message_start\ndata: " + `{"type":"message_start","message":{"id":"msg_1","type":"message",` +
				`"role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":0,"output_tokens":0}}}`,
			"event: content_block_delta\ndata: " + `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"the answer"}}`,
		} {
			fmt.Fprint(w, event+"\n\n")
			flusher.Flush()
		}
		// The rest would follow; the caller is gone before it does.
		<-r.Context().Done()
	})
	id := h.createChannel(channelInput{
		Name: "slow-close", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})

	resp := h.relayRequest(http.MethodPost, "/v1/messages", h.createKey(),
		`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,`+
			`"messages":[{"role":"user","content":"a prompt long enough to estimate"}]}`)
	got := make(chan bool, 1)
	go func() {
		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if strings.Contains(line, "the answer") {
				got <- true
				return
			}
			if err != nil {
				got <- false
				return
			}
		}
	}()
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("the stream ended before the content arrived")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no content within 5s")
	}
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if !entry.Cancelled {
		t.Fatalf("a caller that hung up was not marked cancelled: error %q", entry.Error)
	}
	if entry.Cost == 0 || !entry.PromptEstimated {
		t.Fatalf("delivered content went unbilled: cost %d, prompt %d, estimated %v",
			entry.Cost, entry.PromptTokens, entry.PromptEstimated)
	}

	var report struct {
		Data map[string]struct {
			Hour struct {
				Attempts int64 `json:"attempts"`
				Failures int64 `json:"failures"`
			} `json:"hour"`
		} `json:"data"`
	}
	h.waitFor(t, "the attempt to be counted", func() bool {
		h.do(http.MethodGet, "/api/admin/channels/health", h.admin, nil, &report)
		return report.Data[fmt.Sprint(id)].Hour.Attempts == 1
	})
	if report.Data[fmt.Sprint(id)].Hour.Failures != 0 {
		t.Fatal("a caller hanging up was counted against the channel")
	}
}

// A client that reads an error event and hangs up before the upstream closes
// the stream has cancelled nothing: the call failed, the upstream's message is
// the one logged, and the channel carries the failure.
func TestHangingUpOnAStreamErrorKeepsTheFailure(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		fmt.Fprint(w, "event: ping\ndata: {\"type\":\"ping\"}\n\n")
		fmt.Fprint(w, "event: error\ndata: "+`{"type":"error","error":{"type":"rate_limit_error",`+
			`"message":"Concurrency limit exceeded for account"}}`+"\n\n")
		flusher.Flush()
		// A gateway that holds the connection open after its error event.
		<-r.Context().Done()
	})
	id := h.createChannel(channelInput{
		Name: "error-then-hold", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})

	resp := h.relayRequest(http.MethodPost, "/v1/messages", h.createKey(),
		`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,`+
			`"messages":[{"role":"user","content":"hi"}]}`)
	got := make(chan bool, 1)
	go func() {
		reader := bufio.NewReader(resp.Body)
		for {
			line, err := reader.ReadString('\n')
			if strings.Contains(line, "Concurrency limit exceeded") {
				got <- true
				return
			}
			if err != nil {
				got <- false
				return
			}
		}
	}()
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("the stream ended before the error event arrived")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no error event within 5s")
	}
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.Cancelled || !entry.Failed() {
		t.Fatalf("hanging up on an upstream error was logged as a cancellation: %+v", entry)
	}
	if entry.StatusCode != http.StatusTooManyRequests ||
		!strings.Contains(entry.Error, "Concurrency limit exceeded") {
		t.Fatalf("logged %d %q, want the upstream's rate limit", entry.StatusCode, entry.Error)
	}

	var report struct {
		Data map[string]struct {
			Hour struct {
				Attempts int64 `json:"attempts"`
				Failures int64 `json:"failures"`
			} `json:"hour"`
		} `json:"data"`
	}
	h.waitFor(t, "the attempt to be counted", func() bool {
		h.do(http.MethodGet, "/api/admin/channels/health", h.admin, nil, &report)
		return report.Data[fmt.Sprint(id)].Hour.Attempts == 1
	})
	if report.Data[fmt.Sprint(id)].Hour.Failures != 1 {
		t.Fatal("the upstream's error was not counted against the channel")
	}
}
