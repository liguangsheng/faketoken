package relay

import (
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/redact"
)

func TestUsageSnifferCapturesStreamingResponse(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: {\"delta\":\"hello\",\"api_key\":\"secret\"}\n\n"))

	raw, truncated := sniff.Capture()
	if truncated {
		t.Fatal("small stream was marked truncated")
	}
	body, _ := redact.Body("text/event-stream", raw, truncated, redact.DefaultCaptureLimit)
	if !strings.Contains(body, "hello") || strings.Contains(body, "secret") {
		t.Fatalf("unexpected captured stream: %s", body)
	}
}

// Zero tokens is what gives a canned reply away, so the estimate has to be in
// the right range for both scripts rather than merely non-zero.
func TestEstimateTokens(t *testing.T) {
	tests := []struct {
		name     string
		text     string
		min, max int
	}{
		// ~30 words of English; a real tokenizer lands near 40.
		{
			name: "english prose",
			text: strings.Repeat("the quick brown fox jumps over the lazy dog ", 4),
			min:  30, max: 60,
		},
		// Chinese runs near one token per character, so 40 characters must not
		// be reported as the 10 a four-chars-per-token rule would give.
		{
			name: "chinese prose",
			text: strings.Repeat("北国风光千里冰封万里雪飘", 4),
			min:  35, max: 60,
		},
		{name: "empty", text: "", min: 0, max: 0},
		{name: "single character", text: "x", min: 1, max: 1},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := estimateTokens(tc.text)
			if got < tc.min || got > tc.max {
				t.Fatalf("estimateTokens = %d, want between %d and %d", got, tc.min, tc.max)
			}
		})
	}
}
