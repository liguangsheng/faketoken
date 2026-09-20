package redact

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestBodyRedactsSecretsAndPreservesConversation(t *testing.T) {
	body, truncated := Body("application/json", []byte(`{
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

func TestHeadersRedactsCredentials(t *testing.T) {
	headers := http.Header{
		"Authorization":  {"Bearer sk-client-secret"},
		"Cookie":         {"session=secret"},
		"X-Custom-Trace": {"trace-123"},
	}
	got := Headers(headers)

	if got["Authorization"][0] != "[REDACTED]" || got["Cookie"][0] != "[REDACTED]" {
		t.Fatalf("credential headers were not redacted: %#v", got)
	}
	if got["X-Custom-Trace"][0] != "trace-123" {
		t.Fatalf("ordinary header was lost: %#v", got)
	}
}

// A body over the limit must not be stored in part: half a JSON document reads
// as though the request really was malformed.
func TestBodyOmitsOversizedJSON(t *testing.T) {
	large := fmt.Sprintf(`{"content":%q}`, strings.Repeat("x", 4096))
	body, truncated := Body("application/json", []byte(large), false, 512)

	if !truncated {
		t.Fatal("an oversized body was not marked truncated")
	}
	if !strings.Contains(body, "JSON body omitted") {
		t.Fatalf("expected an omission note, got: %s", body)
	}
}

// Pretty-printing grows a body, so the rendered form is what has to be capped —
// checking only the raw bytes would let the stored string exceed the limit.
func TestBodyCapsTheRenderedForm(t *testing.T) {
	// Comfortably inside the raw limit, but indenting pushes it past.
	raw := `{"a":"` + strings.Repeat("y", 200) + `","b":"` + strings.Repeat("z", 200) + `"}`
	limit := len(raw) + 8

	body, truncated := Body("application/json", []byte(raw), false, limit)
	if len(body) > limit+len("...[TRUNCATED]") {
		t.Fatalf("stored %d bytes for a %d byte limit", len(body), limit)
	}
	if !truncated {
		t.Fatal("capping the rendered form should report truncation")
	}
}

// Bytes of an image are unreadable in a log and would only take up room.
func TestBodyOmitsBinary(t *testing.T) {
	body, _ := Body("image/png", []byte{0x89, 'P', 'N', 'G', 0x0d, 0x0a}, false, DefaultCaptureLimit)
	if !strings.Contains(body, "binary body omitted") {
		t.Fatalf("binary body was stored as text: %q", body)
	}
}

// A missing Content-Type is common on error replies; treating it as binary
// would throw away the one thing worth reading.
func TestBodyKeepsUntypedText(t *testing.T) {
	body, _ := Body("", []byte("upstream exploded"), false, DefaultCaptureLimit)
	if body != "upstream exploded" {
		t.Fatalf("untyped text body became %q", body)
	}
}
