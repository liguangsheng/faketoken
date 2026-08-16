package relay

import (
	"net/http"
	"testing"
)

func TestReasoningEffort(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{
			name: "openai chat completions",
			body: `{"model":"gpt-5","reasoning_effort":"high"}`,
			want: "high",
		},
		{
			name: "openai responses api",
			body: `{"model":"gpt-5","reasoning":{"effort":"medium"}}`,
			want: "medium",
		},
		{
			name: "anthropic output config",
			body: `{"model":"claude-opus-5","output_config":{"effort":"low"}}`,
			want: "low",
		},
		{
			name: "anthropic extended thinking budget",
			body: `{"model":"claude-opus-5","thinking":{"type":"enabled","budget_tokens":16000}}`,
			want: "16k tokens",
		},
		{
			name: "an odd budget keeps its exact value",
			body: `{"thinking":{"type":"enabled","budget_tokens":1234}}`,
			want: "1234 tokens",
		},
		{
			// Disabled thinking is not an effort level; reporting "0 tokens"
			// would read as if the caller had asked for something.
			name: "anthropic thinking disabled",
			body: `{"thinking":{"type":"disabled"}}`,
			want: "",
		},
		{
			name: "anthropic enabled without a budget",
			body: `{"thinking":{"type":"enabled"}}`,
			want: "enabled",
		},
		{
			name: "gemini thinking config",
			body: `{"generationConfig":{"thinkingConfig":{"thinkingBudget":8000}}}`,
			want: "8k tokens",
		},
		{
			// The explicit field wins so the log matches what the upstream
			// will actually honour.
			name: "top level wins over nested",
			body: `{"reasoning_effort":"high","reasoning":{"effort":"low"}}`,
			want: "high",
		},
		{name: "absent", body: `{"model":"gpt-4o"}`, want: ""},
		{name: "not an object", body: `[1,2,3]`, want: ""},
		{name: "malformed", body: `{"reasoning_effort":`, want: ""},
		{name: "wrong type", body: `{"reasoning_effort":42}`, want: ""},
		{name: "blank", body: `{"reasoning_effort":"  "}`, want: ""},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := reasoningEffort([]byte(tc.body), true); got != tc.want {
				t.Fatalf("reasoningEffort = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestReasoningEffortIgnoresNonJSON(t *testing.T) {
	// A multipart upload must not be parsed as JSON.
	if got := reasoningEffort([]byte(`{"reasoning_effort":"high"}`), false); got != "" {
		t.Fatalf("non-JSON body was parsed: %q", got)
	}
}

func TestClientType(t *testing.T) {
	tests := []struct {
		name    string
		headers map[string]string
		want    string
	}{
		{
			name:    "codex tui via originator",
			headers: map[string]string{"Originator": "codex-tui"},
			want:    "codex-tui",
		},
		{
			// Underscores are the same product as hyphens.
			name:    "codex tui with underscores",
			headers: map[string]string{"Originator": "codex_tui"},
			want:    "codex-tui",
		},
		{
			name:    "codex cli falls back to the family",
			headers: map[string]string{"Originator": "codex_cli_rs"},
			want:    "codex",
		},
		{
			name:    "codex desktop is distinguished",
			headers: map[string]string{"User-Agent": "Codex Desktop/0.144.2"},
			want:    "codex-desktop",
		},
		{
			name:    "claude code",
			headers: map[string]string{"User-Agent": "claude-code/1.0.4"},
			want:    "claude-code",
		},
		{
			// What Claude Code actually sends. The product name never appears,
			// which is why this used to be mislabelled.
			name: "claude code identifies itself as claude-cli",
			headers: map[string]string{
				"User-Agent":        "claude-cli/2.1.202 (external, sdk-ts, agent-sdk/0.3.202)",
				"Anthropic-Version": "2023-06-01",
			},
			want: "claude-code",
		},
		{
			name: "axonhub",
			headers: map[string]string{
				"User-Agent":        "axonhub/1.0",
				"Anthropic-Version": "2023-06-01",
			},
			want: "axonhub",
		},
		{
			name:    "opencode",
			headers: map[string]string{"User-Agent": "opencode/0.3.1"},
			want:    "opencode",
		},
		{
			name:    "openai sdk",
			headers: map[string]string{"User-Agent": "OpenAI/Python 1.55.0 openai-python"},
			want:    "openai-sdk",
		},
		{
			name:    "curl",
			headers: map[string]string{"User-Agent": "curl/8.5.0"},
			want:    "curl",
		},
		{
			name:    "browser",
			headers: map[string]string{"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120"},
			want:    "browser",
		},
		{
			// The version header is required by the protocol, so it says
			// nothing about which client sent the request.
			name:    "the anthropic version header is not an identity",
			headers: map[string]string{"Anthropic-Version": "2023-06-01"},
			want:    "unknown",
		},
		{
			// The real Anthropic SDK still names itself.
			name:    "the actual anthropic sdk",
			headers: map[string]string{"User-Agent": "Anthropic/Python 0.39.0 anthropic-python"},
			want:    "anthropic-sdk",
		},
		{
			name:    "go http client is not identifiable",
			headers: map[string]string{"User-Agent": "Go-http-client/2.0"},
			want:    "unknown",
		},
		{
			name:    "nothing to go on",
			headers: map[string]string{"User-Agent": "SomeTool/1.0"},
			want:    "unknown",
		},
		{name: "no headers at all", headers: nil, want: "unknown"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
			if err != nil {
				t.Fatal(err)
			}
			for name, value := range tc.headers {
				req.Header.Set(name, value)
			}
			if got := clientType(req); got != tc.want {
				t.Fatalf("clientType = %q, want %q", got, tc.want)
			}
		})
	}
}
