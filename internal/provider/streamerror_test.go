package provider

import "testing"

// The failures below are all things upstreams actually send with a 2xx status.
// Recognising them is the whole point: scored on the status line they look like
// perfectly served requests.
func TestExtractStreamErrorRecognisesEveryDialect(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		message string
		errType string
		status  int
	}{
		{
			name:    "anthropic error event",
			payload: `{"error":{"message":"Concurrency limit exceeded for account, please retry later","type":"rate_limit_error"},"type":"error"}`,
			message: "Concurrency limit exceeded for account, please retry later",
			errType: "rate_limit_error",
		},
		{
			name:    "anthropic overloaded",
			payload: `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
			message: "Overloaded",
			errType: "overloaded_error",
		},
		{
			name:    "openai style error chunk",
			payload: `{"error":{"message":"upstream load balancer failed","type":"server_error","code":"internal"}}`,
			message: "upstream load balancer failed",
			errType: "server_error",
		},
		{
			name:    "gemini nests the http code",
			payload: `{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}`,
			message: "Resource has been exhausted",
			status:  429,
		},
		{
			name:    "gateway sends only a code",
			payload: `{"error":{"code":503}}`,
			message: "upstream reported HTTP 503",
			status:  503,
		},
		{
			name:    "gateway sends only a type",
			payload: `{"error":{"type":"quota_exceeded"}}`,
			message: "quota_exceeded",
			errType: "quota_exceeded",
		},
		{
			name:    "responses api failure",
			payload: `{"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"model unavailable"}}}`,
			message: "model unavailable",
			errType: "failed",
		},
		{
			name:    "responses api incomplete",
			payload: `{"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"content_filter"}}}`,
			message: "response incomplete: content_filter",
			errType: "incomplete",
		},
		{
			name:    "bare error event with no payload detail",
			payload: `{"type":"error"}`,
			message: "upstream sent an error event",
			errType: "error",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ExtractStreamError([]byte(tc.payload))
			if !ok {
				t.Fatalf("failure went unrecognised: %s", tc.payload)
			}
			if got.Message != tc.message {
				t.Errorf("Message = %q, want %q", got.Message, tc.message)
			}
			if got.Type != tc.errType {
				t.Errorf("Type = %q, want %q", got.Type, tc.errType)
			}
			if got.Status != tc.status {
				t.Errorf("Status = %d, want %d", got.Status, tc.status)
			}
		})
	}
}

// A false positive is worse than a miss: it would bench a healthy channel and
// stamp an error on a request the caller was served correctly.
func TestExtractStreamErrorIgnoresHealthyPayloads(t *testing.T) {
	healthy := []string{
		`{"choices":[{"delta":{"content":"hello"}}]}`,
		// Model output about errors is a string inside content, never a
		// top-level error object.
		`{"choices":[{"delta":{"content":"the error was a missing semicolon"}}]}`,
		`{"choices":[{"delta":{"content":"{\"error\":{\"message\":\"nope\"}}"}}]}`,
		// Some gateways always send the key, empty when nothing went wrong.
		`{"choices":[{"delta":{}}],"error":null}`,
		`{"error":{}}`,
		`{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}`,
		`{"type":"message_stop"}`,
		`{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`,
		`{"type":"response.completed","response":{"status":"completed"}}`,
		// A per-choice error field is not a request-level failure; only a
		// top-level object counts.
		`{"choices":[{"finish_reason":"stop","error":"none"}]}`,
		`[DONE]`,
		`not json at all`,
		``,
	}

	for _, payload := range healthy {
		if e, ok := ExtractStreamError([]byte(payload)); ok {
			t.Errorf("healthy payload flagged as %q: %s", e.Message, payload)
		}
	}
}

// Gemini streams without alt=sse arrive as one array of chunks, so a failure
// can be buried in an element rather than at the top level.
func TestExtractStreamErrorReadsArrayBodies(t *testing.T) {
	body := `[{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]},` +
		`{"error":{"code":500,"message":"internal"}}]`

	got, ok := ExtractStreamError([]byte(body))
	if !ok {
		t.Fatal("an error inside an array body went unrecognised")
	}
	if got.Message != "internal" || got.Status != 500 {
		t.Fatalf("got %+v, want internal/500", got)
	}

	if _, ok := ExtractStreamError([]byte(`[{"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}]`)); ok {
		t.Fatal("a healthy array body was flagged")
	}
}

// The first failure is the useful one; what follows is the upstream shutting
// down, and a later generic message would displace the real reason.
func TestStreamErrorAccumulatorKeepsTheFirstFailure(t *testing.T) {
	var acc StreamErrorAccumulator

	if acc.Feed([]byte(`{"choices":[{"delta":{"content":"hi"}}]}`)) {
		t.Fatal("a content chunk was recorded as a failure")
	}
	if !acc.Feed([]byte(`{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`)) {
		t.Fatal("the first failure was not recorded")
	}
	if acc.Feed([]byte(`{"type":"error","error":{"message":"stream closed"}}`)) {
		t.Fatal("a later failure displaced the first one")
	}

	got, ok := acc.Result()
	if !ok || got.Message != "slow down" {
		t.Fatalf("Result = %+v, %v; want the first failure", got, ok)
	}
}

// RateLimited decides which in-body failures stand for a 429. The relay uses
// it to rewrite the bookkeeping of a stream that ends in a rate limit, so the
// table pins both directions: what must be judged a rate limit, and what must
// keep the status line it relayed.
func TestStreamErrorRateLimited(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    bool
	}{
		{
			name:    "anthropic rate limit",
			payload: `{"error":{"message":"Concurrency limit exceeded","type":"rate_limit_error"}}`,
			want:    true,
		},
		{
			name:    "gateway rate limit variant",
			payload: `{"error":{"message":"slow down","type":"rate_limit_exceeded"}}`,
			want:    true,
		},
		{
			name:    "plain http name",
			payload: `{"error":{"type":"too_many_requests","message":"slow down"}}`,
			want:    true,
		},
		{
			name:    "gemini nests the code",
			payload: `{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}`,
			want:    true,
		},
		{
			name:    "gemini enum as the type",
			payload: `{"error":{"type":"RESOURCE_EXHAUSTED","message":"quota"}}`,
			want:    true,
		},
		// Failures that are not rate limits. They are still logged with their
		// reason and still bench the channel, but the relay keeps the 200 it
		// relayed and bills the usage the stream carried.
		{
			name:    "overloaded",
			payload: `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`,
			want:    false,
		},
		{
			name:    "server error",
			payload: `{"error":{"message":"boom","type":"server_error"}}`,
			want:    false,
		},
		{
			name:    "gateway names only a code",
			payload: `{"error":{"code":503}}`,
			want:    false,
		},
		{
			name:    "quota exhaustion",
			payload: `{"error":{"type":"insufficient_quota","message":"You exceeded your current quota"}}`,
			want:    false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e, ok := ExtractStreamError([]byte(tc.payload))
			if !ok {
				t.Fatalf("failure went unrecognised: %s", tc.payload)
			}
			if got := e.RateLimited(); got != tc.want {
				t.Errorf("RateLimited() = %v, want %v for %+v", got, tc.want, e)
			}
		})
	}
}
