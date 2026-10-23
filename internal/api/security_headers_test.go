package api

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The inline theme script has to run under the policy, so its hash is taken
// from the built file; a script with src is covered by 'self' instead.
func TestConsolePolicyAllowsTheShippedInlineScript(t *testing.T) {
	dir := t.TempDir()
	inline := "\n  document.documentElement.dataset.theme = 'dark'\n"
	html := "<!doctype html><head><script>" + inline + "</script>" +
		`<script type="module" crossorigin src="/assets/index-abc.js"></script></head>`
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte(html), 0o600); err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256([]byte(inline))
	want := "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
	policy := consolePolicy(dir)

	if !strings.Contains(policy, "script-src 'self' "+want+";") {
		t.Fatalf("policy %q does not allow exactly the inline script", policy)
	}
	if strings.Count(policy, "'sha256-") != 1 {
		t.Fatalf("policy %q hashed the external script too", policy)
	}
	for _, directive := range []string{"object-src 'none'", "frame-ancestors 'none'", "base-uri 'self'"} {
		if !strings.Contains(policy, directive) {
			t.Fatalf("policy %q is missing %s", policy, directive)
		}
	}
}

// ---------------------------------------------------------------- over HTTP

func TestConsoleResponsesCarrySecurityHeadersAndRelayOnesDoNot(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/", "/admin/settings", "/api/status"} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if !strings.HasPrefix(resp.Header.Get("Content-Security-Policy"), "script-src 'self'") {
			t.Fatalf("%s: Content-Security-Policy %q", path, resp.Header.Get("Content-Security-Policy"))
		}
		if resp.Header.Get("X-Content-Type-Options") != "nosniff" ||
			resp.Header.Get("X-Frame-Options") != "DENY" {
			t.Fatalf("%s: missing nosniff or frame protection: %v", path, resp.Header)
		}
	}

	// Relayed responses are the upstream's, header for header.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "plain", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(), `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("relay: HTTP %d", resp.StatusCode)
	}
	for _, name := range []string{"Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options"} {
		if got := resp.Header.Get(name); got != "" {
			t.Fatalf("the relay added %s: %q", name, got)
		}
	}
}
