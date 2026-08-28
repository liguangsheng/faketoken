package relay

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestRewriteReasoningEffortAcrossDialects(t *testing.T) {
	mapping := map[string]string{"max": "xhigh"}

	tests := []struct {
		name string
		body string
		want string
		from string
		to   string
	}{
		{
			name: "chat completions",
			body: `{"model":"gpt-5","reasoning_effort":"max"}`,
			want: `{"model":"gpt-5","reasoning_effort":"xhigh"}`,
			from: "max", to: "xhigh",
		},
		{
			name: "responses nested",
			body: `{"model":"gpt-5","reasoning":{"effort":"max","summary":"auto"}}`,
			want: `{"model":"gpt-5","reasoning":{"effort":"xhigh","summary":"auto"}}`,
			from: "max", to: "xhigh",
		},
		{
			name: "anthropic output config",
			body: `{"model":"claude","output_config":{"effort":"max"}}`,
			want: `{"model":"claude","output_config":{"effort":"xhigh"}}`,
			from: "max", to: "xhigh",
		},
		{
			// The rule is keyed case-insensitively; the replacement is stored as
			// typed, because an upstream's level name may well be case-sensitive.
			name: "level matched case-insensitively",
			body: `{"reasoning_effort":"MAX"}`,
			want: `{"reasoning_effort":"xhigh"}`,
			from: "MAX", to: "xhigh",
		},
		{
			name: "level with no rule is forwarded untouched",
			body: `{"model":"gpt-5","reasoning_effort":"high"}`,
			want: `{"model":"gpt-5","reasoning_effort":"high"}`,
		},
		{
			name: "no effort field at all",
			body: `{"model":"gpt-5","messages":[]}`,
			want: `{"model":"gpt-5","messages":[]}`,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, from, to := rewriteReasoningEffort([]byte(tc.body), mapping)
			if string(got) != tc.want {
				t.Errorf("body\n got: %s\nwant: %s", got, tc.want)
			}
			if from != tc.from || to != tc.to {
				t.Errorf("applied = %q -> %q, want %q -> %q", from, to, tc.from, tc.to)
			}
		})
	}
}

func TestRewriteReasoningEffortRewritesEverySpellingPresent(t *testing.T) {
	// A client that sends two spellings must have both renamed: leaving one
	// saying the level this upstream refuses is the failure the rule exists to
	// prevent.
	body := `{"reasoning_effort":"max","reasoning":{"effort":"max"}}`
	got, _, _ := rewriteReasoningEffort([]byte(body), map[string]string{"max": "xhigh"})

	if strings.Contains(string(got), `"max"`) {
		t.Fatalf("a spelling was left unmapped: %s", got)
	}
	var decoded struct {
		Effort    string `json:"reasoning_effort"`
		Reasoning struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
	}
	if err := json.Unmarshal(got, &decoded); err != nil {
		t.Fatalf("result is not valid JSON: %v (%s)", err, got)
	}
	if decoded.Effort != "xhigh" || decoded.Reasoning.Effort != "xhigh" {
		t.Fatalf("unexpected result: %s", got)
	}
}

func TestRewriteReasoningEffortPreservesEverythingElse(t *testing.T) {
	// Same guarantee the model rewrite gives: field order, whitespace and
	// numeric formatting survive, because only the level's bytes are spliced.
	in := "{\n  \"seed\": 100000000000000000000000000000,\n  \"reasoning_effort\"  :  \"max\",\n  \"top_p\": 0.10\n}"
	got, _, _ := rewriteReasoningEffort([]byte(in), map[string]string{"max": "xhigh"})

	out := string(got)
	if !strings.Contains(out, "100000000000000000000000000000") {
		t.Errorf("large integer was mangled: %s", out)
	}
	if !strings.Contains(out, "0.10") {
		t.Errorf("float formatting was mangled: %s", out)
	}
	if !strings.Contains(out, `"xhigh"`) {
		t.Errorf("level was not rewritten: %s", out)
	}
}

func TestRewriteReasoningEffortLeavesTokenBudgetsAlone(t *testing.T) {
	// A rule renames one level to another. Turning "max" into a token count is a
	// different feature, and a wrong guess there costs real money.
	body := `{"thinking":{"type":"enabled","budget_tokens":32000}}`
	got, from, _ := rewriteReasoningEffort([]byte(body), map[string]string{"max": "xhigh", "enabled": "xhigh"})

	if string(got) != body {
		t.Fatalf("token budget was altered: %s", got)
	}
	if from != "" {
		t.Fatalf("reported a rename that did not happen: %q", from)
	}
}

func TestRewriteReasoningEffortWithoutRules(t *testing.T) {
	body := `{"reasoning_effort":"max"}`
	for _, mapping := range []map[string]string{nil, {}} {
		got, from, to := rewriteReasoningEffort([]byte(body), mapping)
		if string(got) != body || from != "" || to != "" {
			t.Fatalf("empty mapping changed the request: %s (%q -> %q)", got, from, to)
		}
	}
}

func TestRewriteReasoningEffortIgnoresMalformedBody(t *testing.T) {
	body := `{"reasoning_effort":`
	got, from, _ := rewriteReasoningEffort([]byte(body), map[string]string{"max": "xhigh"})
	if string(got) != body || from != "" {
		t.Fatalf("malformed body was altered: %s", got)
	}
}

func TestRewriteReasoningEffortNoopWhenRuleMatchesItself(t *testing.T) {
	// A rule that maps a level onto itself is not a rename, so nothing is
	// spliced and the log keeps reading as the plain requested level.
	body := `{"reasoning_effort":"high"}`
	got, from, _ := rewriteReasoningEffort([]byte(body), map[string]string{"high": "high"})
	if string(got) != body || from != "" {
		t.Fatalf("self-mapping was treated as a rename: %s (%q)", got, from)
	}
}
