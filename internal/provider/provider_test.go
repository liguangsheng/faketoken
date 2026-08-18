package provider

import (
	"net/http"
	"slices"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func TestJoinURL(t *testing.T) {
	tests := []struct {
		base, path, want string
	}{
		{"https://api.openai.com", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		{"https://api.openai.com/", "/v1/chat/completions", "https://api.openai.com/v1/chat/completions"},
		// The classic copy/paste: base already ends with the version segment.
		{"https://relay.example.com/v1", "/v1/chat/completions", "https://relay.example.com/v1/chat/completions"},
		{"https://generativelanguage.googleapis.com/v1beta", "/v1beta/models/x:generateContent",
			"https://generativelanguage.googleapis.com/v1beta/models/x:generateContent"},
		// A genuine sub-path prefix must be preserved.
		{"https://gw.example.com/llm", "/v1/messages", "https://gw.example.com/llm/v1/messages"},
		{"https://gw.example.com/openai/v1", "/v1/models", "https://gw.example.com/openai/v1/models"},
	}
	for _, tc := range tests {
		if got := JoinURL(tc.base, tc.path); got != tc.want {
			t.Errorf("JoinURL(%q, %q) = %q, want %q", tc.base, tc.path, got, tc.want)
		}
	}
}

func TestGeminiModelInPath(t *testing.T) {
	path := "/v1beta/models/gemini-2.5-pro:streamGenerateContent"
	if got := GeminiModelFromPath(path); got != "gemini-2.5-pro" {
		t.Fatalf("got %q", got)
	}
	got := ReplaceGeminiModelInPath(path, "gemini-2.5-pro", "gemini-2.5-pro-preview")
	want := "/v1beta/models/gemini-2.5-pro-preview:streamGenerateContent"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestAuthStyleForRequestPath(t *testing.T) {
	tests := map[string]string{
		"/v1/messages":              "x-api-key",
		"/v1/messages/count_tokens": "x-api-key",
		"/v1/chat/completions":      "bearer",
		"/v1/responses":             "bearer",
		"/v1/embeddings":            "bearer",
		"/v1beta/models/gemini-2.5-pro:generateContent":       "x-goog-api-key",
		"/v1beta/models/gemini-2.5-pro:streamGenerateContent": "x-goog-api-key",
		"/v1beta/models/gemini-2.5-pro:countTokens":           "x-goog-api-key",
		"/v1/models/gemini-2.5-pro:generateContent":           "x-goog-api-key",
	}
	for path, want := range tests {
		if got := AuthStyleForRequestPath(path); got != want {
			t.Errorf("AuthStyleForRequestPath(%q) = %q, want %q", path, got, want)
		}
	}
}

func TestApplyAuthHonoursExplicitOverrides(t *testing.T) {
	tests := []struct {
		name, path, style    string
		wantAuthorization    string
		wantXAPIKey          string
		wantXGoogAPIKey      string
		wantAnthropicVersion bool
	}{
		{name: "auto messages", path: "/v1/messages", style: model.AuthStyleAuto,
			wantXAPIKey: "channel-secret", wantAnthropicVersion: true},
		{name: "bearer overrides messages", path: "/v1/messages", style: model.AuthStyleBearer,
			wantAuthorization: "Bearer channel-secret"},
		{name: "x-api-key overrides chat", path: "/v1/chat/completions", style: model.AuthStyleXAPIKey,
			wantXAPIKey: "channel-secret", wantAnthropicVersion: true},
		{name: "google overrides chat", path: "/v1/chat/completions", style: model.AuthStyleXGoogAPIKey,
			wantXGoogAPIKey: "channel-secret"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, "https://upstream.test"+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			// Every client credential must be removed before the channel's
			// selected form is installed.
			req.Header.Set("Authorization", "Bearer caller-secret")
			req.Header.Set("X-Api-Key", "caller-secret")
			req.Header.Set("X-Goog-Api-Key", "caller-secret")

			ApplyAuth(req, "channel-secret", tc.style)

			if got := req.Header.Get("Authorization"); got != tc.wantAuthorization {
				t.Errorf("Authorization = %q, want %q", got, tc.wantAuthorization)
			}
			if got := req.Header.Get("X-Api-Key"); got != tc.wantXAPIKey {
				t.Errorf("X-Api-Key = %q, want %q", got, tc.wantXAPIKey)
			}
			if got := req.Header.Get("X-Goog-Api-Key"); got != tc.wantXGoogAPIKey {
				t.Errorf("X-Goog-Api-Key = %q, want %q", got, tc.wantXGoogAPIKey)
			}
			if got := req.Header.Get("Anthropic-Version") != ""; got != tc.wantAnthropicVersion {
				t.Errorf("Anthropic-Version present = %v, want %v", got, tc.wantAnthropicVersion)
			}
		})
	}
}

func TestParseModelsAcceptsCommonShapes(t *testing.T) {
	tests := map[string]struct {
		body string
		want []string
	}{
		"data objects": {
			body: `{"data":[{"id":"gpt-5"},{"id":"gpt-5"}]}`,
			want: []string{"gpt-5"},
		},
		"models names": {
			body: `{"models":[{"name":"models/gemini-2.5-pro"}]}`,
			want: []string{"gemini-2.5-pro"},
		},
		"bare strings": {
			body: `["a","b"]`,
			want: []string{"a", "b"},
		},
		"mixed objects": {
			body: `[{"model":"m1"},{"id":"m2"},"m3"]`,
			want: []string{"m1", "m2", "m3"},
		},
	}
	for name, tc := range tests {
		t.Run(name, func(t *testing.T) {
			models, err := ParseModels([]byte(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			if !slices.Equal(models, tc.want) {
				t.Fatalf("models = %v, want %v", models, tc.want)
			}
		})
	}
}

func TestExtractUsage(t *testing.T) {
	tests := []struct {
		name                               string
		body                               string
		prompt, completion, cached, create int
	}{
		{
			name: "openai",
			body: `{"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17,
			        "prompt_tokens_details":{"cached_tokens":8}}}`,
			prompt: 12, completion: 5, cached: 8,
		},
		{
			// The write half is reported separately but stays inside the
			// prompt total, so cost calculations are unaffected.
			name: "anthropic final",
			body: `{"usage":{"input_tokens":100,"output_tokens":42,
			        "cache_read_input_tokens":20,"cache_creation_input_tokens":5}}`,
			prompt: 125, completion: 42, cached: 20, create: 5,
		},
		{
			name: "anthropic message_start",
			body: `{"type":"message_start","message":{"usage":{"input_tokens":9,"output_tokens":1,
			        "cache_creation_input_tokens":4}}}`,
			prompt: 13, completion: 1, create: 4,
		},
		{
			name: "gemini",
			body: `{"usageMetadata":{"promptTokenCount":30,"candidatesTokenCount":7,
			        "thoughtsTokenCount":3,"totalTokenCount":40,"cachedContentTokenCount":11}}`,
			prompt: 30, completion: 10, cached: 11,
		},
		{
			name: "anthropic responses completed",
			body: `{"type":"response.completed","response":{"usage":{"input_tokens":84559,
			        "input_tokens_details":{"cache_write_tokens":103349,"cached_tokens":0},
			        "output_tokens":123,"output_tokens_details":{"reasoning_tokens":0},
			        "total_tokens":84682}}}`,
			prompt: 84559, completion: 123, cached: 0, create: 103349,
		},
		{
			name: "anthropic responses cached read",
			body: `{"type":"response.completed","response":{"usage":{"input_tokens":83637,
			        "input_tokens_details":{"cache_write_tokens":0,"cached_tokens":102224},
			        "output_tokens":33,"total_tokens":83670}}}`,
			prompt: 83637, completion: 33, cached: 102224, create: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			u, found := ExtractUsage([]byte(tc.body))
			if !found {
				t.Fatal("no usage detected")
			}
			if u.PromptTokens != tc.prompt || u.CompletionTokens != tc.completion ||
				u.CachedTokens != tc.cached || u.CacheCreationTokens != tc.create {
				t.Fatalf("got %+v, want prompt=%d completion=%d cached=%d create=%d",
					u, tc.prompt, tc.completion, tc.cached, tc.create)
			}
		})
	}
}

// The accumulator folds streamed events; cache creation has to survive the
// fold like every other counter.
func TestUsageAccumulatorKeepsCacheCreation(t *testing.T) {
	var acc UsageAccumulator
	acc.Feed([]byte(`{"type":"message_start","message":{"usage":{"input_tokens":10,
	    "cache_creation_input_tokens":7,"cache_read_input_tokens":3}}}`))
	acc.Feed([]byte(`{"usage":{"input_tokens":10,"output_tokens":25,
	    "cache_creation_input_tokens":7,"cache_read_input_tokens":3}}`))

	usage, seen := acc.Result()
	if !seen {
		t.Fatal("no usage accumulated")
	}
	if usage.CacheCreationTokens != 7 {
		t.Fatalf("cache creation = %d, want 7", usage.CacheCreationTokens)
	}
	if usage.CachedTokens != 3 || usage.CompletionTokens != 25 {
		t.Fatalf("unexpected totals: %+v", usage)
	}
}

func TestUsageAccumulatorAnthropicResponses(t *testing.T) {
	var acc UsageAccumulator
	acc.Feed([]byte(`{"type":"response.created","response":{"usage":null}}`))
	acc.Feed([]byte(`{"type":"response.in_progress","response":{"usage":null}}`))
	acc.Feed([]byte(`{"type":"response.output_text.delta","delta":"hello"}`))
	acc.Feed([]byte(`{"type":"response.completed","response":{"usage":{
		"input_tokens":100,"input_tokens_details":{"cache_write_tokens":50,"cached_tokens":10},
		"output_tokens":25,"total_tokens":125}}}`))

	usage, seen := acc.Result()
	if !seen {
		t.Fatal("no usage accumulated")
	}
	if usage.PromptTokens != 100 {
		t.Fatalf("prompt = %d, want 100", usage.PromptTokens)
	}
	if usage.CompletionTokens != 25 {
		t.Fatalf("completion = %d, want 25", usage.CompletionTokens)
	}
	if usage.TotalTokens != 125 {
		t.Fatalf("total = %d, want 125", usage.TotalTokens)
	}
	if usage.CachedTokens != 10 {
		t.Fatalf("cached = %d, want 10", usage.CachedTokens)
	}
	if usage.CacheCreationTokens != 50 {
		t.Fatalf("cache creation = %d, want 50", usage.CacheCreationTokens)
	}
}

func TestExtractUsageIgnoresUnrelatedPayloads(t *testing.T) {
	if _, found := ExtractUsage([]byte(`{"choices":[{"delta":{"content":"hi"}}]}`)); found {
		t.Fatal("usage should not be reported for a content delta")
	}
}

// Streaming dialects report cumulative counters across events; the accumulator
// must converge on the final totals regardless of event order.
func TestUsageAccumulator(t *testing.T) {
	var acc UsageAccumulator
	acc.Feed([]byte(`{"type":"message_start","message":{"usage":{"input_tokens":50,"output_tokens":1}}}`))
	acc.Feed([]byte(`{"type":"content_block_delta"}`))
	acc.Feed([]byte(`{"type":"message_delta","usage":{"output_tokens":123}}`))

	u, seen := acc.Result()
	if !seen {
		t.Fatal("expected usage")
	}
	if u.PromptTokens != 50 || u.CompletionTokens != 123 || u.TotalTokens != 173 {
		t.Fatalf("got %+v", u)
	}
}
