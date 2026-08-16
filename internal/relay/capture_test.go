package relay

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestSanitizeBodyRedactsSecretsAndPreservesConversation(t *testing.T) {
	body, truncated := sanitizeBody("application/json", []byte(`{
		"messages":[{"role":"user","content":"hello"}],
		"api_key":"sk-body-secret",
		"metadata":{"password":"open-sesame"}
	}`), false, DefaultCaptureLimit)

	if truncated {
		t.Fatal("small JSON body was marked truncated")
	}
	if strings.Contains(body, "sk-body-secret") || strings.Contains(body, "open-sesame") {
		t.Fatalf("secret leaked into sanitized body: %s", body)
	}
	if !strings.Contains(body, `"api_key": "[REDACTED]"`) || !strings.Contains(body, "hello") {
		t.Fatalf("body was not redacted as expected: %s", body)
	}
}

func TestSanitizeHeadersRedactsCredentials(t *testing.T) {
	headers := http.Header{
		"Authorization":  {"Bearer sk-client-secret"},
		"Cookie":         {"session=secret"},
		"X-Custom-Trace": {"trace-123"},
	}
	got := sanitizeHeaders(headers)

	if got["Authorization"][0] != "[REDACTED]" || got["Cookie"][0] != "[REDACTED]" {
		t.Fatalf("credential headers were not redacted: %#v", got)
	}
	if got["X-Custom-Trace"][0] != "trace-123" {
		t.Fatalf("ordinary header was lost: %#v", got)
	}
}

func TestUsageSnifferCapturesStreamingResponse(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: {\"delta\":\"hello\",\"api_key\":\"secret\"}\n\n"))

	raw, truncated := sniff.Capture()
	if truncated {
		t.Fatal("small stream was marked truncated")
	}
	body, _ := sanitizeBody("text/event-stream", raw, truncated, DefaultCaptureLimit)
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

// A body over the limit must not be stored in part: half a JSON document reads
// as though the request really was malformed.
func TestSanitizeBodyOmitsOversizedJSON(t *testing.T) {
	large := fmt.Sprintf(`{"content":%q}`, strings.Repeat("x", 4096))
	body, truncated := sanitizeBody("application/json", []byte(large), false, 512)

	if !truncated {
		t.Fatal("an oversized body was not marked truncated")
	}
	if !strings.Contains(body, "JSON body omitted") {
		t.Fatalf("expected an omission note, got: %s", body)
	}
}

// Pretty-printing grows a body, so the rendered form is what has to be capped —
// checking only the raw bytes would let the stored string exceed the limit.
func TestSanitizeBodyCapsTheRenderedForm(t *testing.T) {
	// Comfortably inside the raw limit, but indenting pushes it past.
	raw := `{"a":"` + strings.Repeat("y", 200) + `","b":"` + strings.Repeat("z", 200) + `"}`
	limit := len(raw) + 8

	body, truncated := sanitizeBody("application/json", []byte(raw), false, limit)
	if len(body) > limit+len("...[TRUNCATED]") {
		t.Fatalf("stored %d bytes for a %d byte limit", len(body), limit)
	}
	if !truncated {
		t.Fatal("capping the rendered form should report truncation")
	}
}

// Bytes of an image are unreadable in a log and would only take up room.
func TestSanitizeBodyOmitsBinary(t *testing.T) {
	body, _ := sanitizeBody("image/png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a}, false, DefaultCaptureLimit)
	if !strings.Contains(body, "binary body omitted") {
		t.Fatalf("binary body was stored as text: %q", body)
	}
}

// A missing Content-Type is common on error replies; treating it as binary
// would throw away the one thing worth reading.
func TestSanitizeBodyKeepsUntypedText(t *testing.T) {
	body, _ := sanitizeBody("", []byte("upstream exploded"), false, DefaultCaptureLimit)
	if body != "upstream exploded" {
		t.Fatalf("untyped text body became %q", body)
	}
}
