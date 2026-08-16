package provider

import "testing"

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
