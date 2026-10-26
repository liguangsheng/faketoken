package conversation

import (
	"net/http"
	"strings"
	"testing"
)

func TestSessionIDPrefersTheMostSpecificHeader(t *testing.T) {
	h := http.Header{}
	h.Set("session_id", "pi-1")
	h.Set("X-Claude-Code-Session-Id", "6f1c2a9e-1111-2222-3333-444455556666")
	if got := SessionID(h); got != "6f1c2a9e-1111-2222-3333-444455556666" {
		t.Fatalf("SessionID = %q, want the Claude Code header", got)
	}

	h.Del("X-Claude-Code-Session-Id")
	if got := SessionID(h); got != "pi-1" {
		t.Fatalf("SessionID = %q, want session_id", got)
	}

	if got := SessionID(http.Header{}); got != "" {
		t.Fatalf("SessionID with no header = %q, want empty", got)
	}
}

func TestSessionIDKeepsOddIdsOutOfThePath(t *testing.T) {
	h := http.Header{}
	h.Set("Session-Id", "a/b c")
	got := SessionID(h)
	if !strings.HasPrefix(got, "h:") || len(got) != 18 || got != SessionID(h) {
		t.Fatalf("SessionID = %q, want a stable h: digest", got)
	}
}

func TestMessagesMatchAcrossTurns(t *testing.T) {
	first := Messages([]byte(`{"model":"m","messages":[
		{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}]}`))
	// The next turn moves the breakpoint and sorts its keys differently.
	second := Messages([]byte(`{"messages":[
		{"content":[{"text":"hi","type":"text"}],"role":"user"},
		{"role":"assistant","content":"hello"},
		{"role":"user","content":[{"type":"text","text":"more","cache_control":{"type":"ephemeral"}}]}],
		"model":"m"}`))
	if len(first) != 1 || len(second) != 3 {
		t.Fatalf("got %d and %d messages, want 1 and 3", len(first), len(second))
	}
	if Shared(second, first) != 1 || second[1] == second[2] {
		t.Fatalf("hashes %v and %v: the first message should match, the rest differ", first, second)
	}
}

func TestMessagesRecognisesEachDialect(t *testing.T) {
	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"contents":[{"role":"user","parts":[{"text":"a"}]}]}`, 1},                     // Gemini
		{`{"input":[{"role":"user","content":"a"},{"type":"function_call_output"}]}`, 2}, // Responses
		{`{"input":"a single prompt"}`, 0},
		{`{"input":["embed", "these"]}`, 0},
		{`{"messages":[]}`, 0},
		{`not json`, 0},
	} {
		if got := len(Messages([]byte(tc.body))); got != tc.want {
			t.Fatalf("%s: %d messages, want %d", tc.body, got, tc.want)
		}
	}
}

func TestShared(t *testing.T) {
	for _, tc := range []struct {
		a, b []int64
		want int
	}{
		{[]int64{1, 2, 3}, []int64{1, 2, 9, 9}, 2},
		{[]int64{1, 2}, []int64{1, 2, 3}, 2},
		{[]int64{4}, []int64{1}, 0},
		{nil, []int64{1}, 0},
	} {
		if got := Shared(tc.a, tc.b); got != tc.want {
			t.Fatalf("Shared(%v, %v) = %d, want %d", tc.a, tc.b, got, tc.want)
		}
	}
}
