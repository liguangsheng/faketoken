package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// A failure the relay consumes and answers itself — every channel failed — is
// sent with the code the last channel's rule names. The row keeps both: what
// the caller got, and, for the operator only, what the upstream said.
func TestStatusMappingRewritesTheFinalFailure(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"message":"slow down"}}`, http.StatusTooManyRequests)
	})
	h.createChannel(channelInput{
		Name: "limited", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		StatusCodeMapping: map[int]int{http.StatusTooManyRequests: http.StatusServiceUnavailable},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want the mapped 503", resp.StatusCode)
	}

	var operator page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &operator)
		r.Body.Close()
		return len(operator.Data) >= 1
	}, waiting("the call to be logged"))
	if row := operator.Data[0]; row.StatusCode != http.StatusServiceUnavailable ||
		row.UpstreamStatus != http.StatusTooManyRequests {
		t.Fatalf("operator row = status %d upstream %d, want 503 over 429",
			row.StatusCode, row.UpstreamStatus)
	}

	// The upstream's code is routing internals, like the upstream model.
	var own page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/logs", h.admin, nil, &own)
	r.Body.Close()
	if len(own.Data) != 1 || own.Data[0].StatusCode != http.StatusServiceUnavailable ||
		own.Data[0].UpstreamStatus != 0 {
		t.Fatalf("owner row = %+v, want 503 with the upstream code withheld", own.Data)
	}
}

// Only the caller's view changes. Mapped onto 400 — a code the relay would never
// retry — a 429 must still send the request on to the next channel.
func TestStatusMappingLeavesFailoverOnTheUpstreamCode(t *testing.T) {
	h := newHarness(t)

	limited := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"message":"slow down"}}`, http.StatusTooManyRequests)
	})
	healthy := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "limited", BaseURL: limited.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100,
		StatusCodeMapping: map[int]int{http.StatusTooManyRequests: http.StatusBadRequest},
	})
	h.createChannel(channelInput{
		Name: "healthy", BaseURL: healthy.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1,
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the fallback's 200", resp.StatusCode)
	}
	if limited.requests.Load() != 1 || healthy.requests.Load() != 1 {
		t.Fatalf("calls: limited=%d healthy=%d, want one each",
			limited.requests.Load(), healthy.requests.Load())
	}
}

// An error the upstream answers for itself is forwarded with its own body; a
// mapped status changes only the status line.
func TestStatusMappingRewritesAForwardedError(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"unknown parameter: foo"}}`)
	})
	h.createChannel(channelInput{
		Name: "strict", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		StatusCodeMapping: map[int]int{http.StatusBadRequest: http.StatusUnprocessableEntity},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o","foo":1}`)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want the mapped 422", resp.StatusCode)
	}
	if !strings.Contains(string(raw), "unknown parameter: foo") {
		t.Fatalf("the upstream body was not passed through: %s", raw)
	}

	row := h.waitForLog(t, 1)
	if row.StatusCode != http.StatusUnprocessableEntity || row.UpstreamStatus != http.StatusBadRequest {
		t.Fatalf("row = status %d upstream %d, want 422 over 400", row.StatusCode, row.UpstreamStatus)
	}
}

// Both sides of a rule are error codes. A success code on either side is
// refused, and a rule onto itself is dropped rather than stored.
func TestStatusMappingValidation(t *testing.T) {
	h := newHarness(t)

	base := map[string]any{
		"name": "mapping", "base_url": "https://up.test", "api_key": "k",
		"models": []string{"gpt-4o"}, "groups": []string{"default"},
	}
	for _, rules := range []map[string]int{
		{"200": 503},
		{"429": 200},
		{"429": 600},
	} {
		body := map[string]any{}
		for k, v := range base {
			body[k] = v
		}
		body["status_code_mapping"] = rules
		resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, body, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%v: HTTP %d, want 400", rules, resp.StatusCode)
		}
	}

	id := h.createChannel(channelInput{
		Name: "mapping", BaseURL: "https://up.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		StatusCodeMapping: map[int]int{429: 503, 500: 500},
	})
	saved := h.channel(id)
	if len(saved.StatusCodeMapping) != 1 || saved.StatusCodeMapping[429] != 503 {
		t.Fatalf("saved mapping = %v, want only 429=503", saved.StatusCodeMapping)
	}
}
