package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func TestMaskSecretKeepsOnlyTheEnds(t *testing.T) {
	if got := maskSecret("short-secret"); got != secretMark {
		t.Fatalf("a short value showed %q, want it hidden whole", got)
	}
	got := maskSecret("Bearer sk-0123456789abcdef")
	if got != "Bear"+secretMark+"cdef" {
		t.Fatalf("long value masked as %q", got)
	}
}

func TestMaskHeadersOnlyTouchesCredentials(t *testing.T) {
	stored := map[string]string{
		"Authorization":             "Bearer sk-0123456789abcdef",
		"Ocp-Apim-Subscription-Key": "0123456789abcdef0123",
		"User-Agent":                "custom/1.0",
	}
	got := maskHeaders(stored)

	if got["User-Agent"] != "custom/1.0" {
		t.Fatalf("an ordinary header was masked: %q", got["User-Agent"])
	}
	for _, name := range []string{"Authorization", "Ocp-Apim-Subscription-Key"} {
		if !strings.Contains(got[name], secretMark) {
			t.Fatalf("%s left the API in the clear: %q", name, got[name])
		}
	}
	if stored["Authorization"] != "Bearer sk-0123456789abcdef" {
		t.Fatal("masking rewrote the stored map instead of a copy")
	}
}

func TestMaskProxyHidesOnlyThePassword(t *testing.T) {
	cases := map[string]string{
		"http://user:hunter2@proxy.local:8080": "http://user:xxxxx@proxy.local:8080",
		"http://proxy.local:8080":              "http://proxy.local:8080",
		"socks5://user@proxy.local:1080":       "socks5://user@proxy.local:1080",
		"":                                     "",
	}
	for raw, want := range cases {
		if got := maskProxy(raw); got != want {
			t.Fatalf("maskProxy(%q) = %q, want %q", raw, got, want)
		}
	}
}

func TestKeepMaskedSecrets(t *testing.T) {
	stored := &model.Channel{
		Headers: map[string]string{
			"Authorization": "Bearer sk-0123456789abcdef",
			"X-Api-Key":     "short",
		},
		ProxyURL: "http://user:hunter2@proxy.local:8080",
	}
	masked := mask(stored)

	// Sent back untouched: everything resolves to what is stored, and a
	// header name in another case still finds its value.
	back := &model.Channel{
		Headers: map[string]string{
			"authorization": masked.Headers["Authorization"],
			"X-Api-Key":     masked.Headers["X-Api-Key"],
		},
		ProxyURL: masked.ProxyURL,
	}
	if message, ok := keepMaskedSecrets(back, stored); !ok {
		t.Fatalf("an untouched form was refused: %s", message)
	}
	if back.Headers["authorization"] != stored.Headers["Authorization"] ||
		back.Headers["X-Api-Key"] != "short" || back.ProxyURL != stored.ProxyURL {
		t.Fatalf("stored credentials were not put back: %+v", back)
	}

	// A new value replaces the old one.
	edited := &model.Channel{Headers: map[string]string{"X-Api-Key": "brand-new"}}
	if _, ok := keepMaskedSecrets(edited, stored); !ok || edited.Headers["X-Api-Key"] != "brand-new" {
		t.Fatalf("an edited value did not stick: %+v", edited.Headers)
	}

	// A placeholder under a name nothing is stored for would save the bullets
	// as the credential.
	renamed := &model.Channel{Headers: map[string]string{"X-Token": masked.Headers["X-Api-Key"]}}
	if _, ok := keepMaskedSecrets(renamed, stored); ok {
		t.Fatal("a placeholder with no stored value behind it was accepted")
	}
	if _, ok := keepMaskedSecrets(&model.Channel{Headers: map[string]string{
		"Authorization": masked.Headers["Authorization"],
	}}, nil); ok {
		t.Fatal("a new channel was allowed to save a placeholder")
	}

	moved := &model.Channel{ProxyURL: "http://user:xxxxx@elsewhere.local:8080"}
	if _, ok := keepMaskedSecrets(moved, stored); ok {
		t.Fatal("a proxy pointed elsewhere kept the masked password")
	}
}

// ---------------------------------------------------------------- over HTTP

func TestChannelCredentialsLeaveTheAPIMasked(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "secret-headers", BaseURL: up.URL, APIKey: "generated-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers: map[string]string{
			"Authorization": "Token channel-override-0123456789",
			"User-Agent":    "custom/1.0",
		},
	})

	var got model.Channel
	h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, nil, &got)
	if !strings.Contains(got.Headers["Authorization"], secretMark) {
		t.Fatalf("the credential header left the API in the clear: %q", got.Headers["Authorization"])
	}
	if got.Headers["User-Agent"] != "custom/1.0" {
		t.Fatalf("an ordinary header was masked: %q", got.Headers["User-Agent"])
	}

	var listed page[model.Channel]
	h.do(http.MethodGet, "/api/admin/channels", h.admin, nil, &listed)
	for _, ch := range listed.Data {
		if strings.Contains(ch.Headers["Authorization"], "channel-override") {
			t.Fatal("the channel list returns the credential header in the clear")
		}
	}

	// The console saves what it was shown. The stored credential has to
	// survive that, which is what the upstream then receives.
	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, channelInput{
		Name: got.Name, BaseURL: got.BaseURL, Models: got.Models, Groups: got.Groups,
		Headers: got.Headers, Note: "edited through the console",
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("saving the masked form: HTTP %d", resp.StatusCode)
	}

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(), `{"model":"gpt-4o"}`)
	defer relayed.Body.Close()
	if relayed.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(relayed.Body)
		t.Fatalf("relay after the save: HTTP %d: %s", relayed.StatusCode, raw)
	}
	if auth := up.auth(); auth != "Token channel-override-0123456789" {
		t.Fatalf("the upstream received %q after the save, want the original credential", auth)
	}

	// Renaming the header keeps only the placeholder, which is refused.
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, channelInput{
		Name: got.Name, BaseURL: got.BaseURL, Models: got.Models, Groups: got.Groups,
		Headers: map[string]string{"X-Auth-Token": got.Headers["Authorization"]},
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a renamed placeholder: HTTP %d, want 400", resp.StatusCode)
	}
}
