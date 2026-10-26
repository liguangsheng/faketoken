package api

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestConsoleSettingsRoundTripAndAuthority(t *testing.T) {
	h := newHarness(t)

	// Before anything is saved the console still needs a usable default.
	var settings consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	if settings.DefaultPageSize != defaultPageSizeFallback {
		t.Fatalf("default page size = %d, want %d", settings.DefaultPageSize, defaultPageSizeFallback)
	}

	settings.DefaultPageSize = 50
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, &settings)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || settings.DefaultPageSize != 50 {
		t.Fatalf("update returned HTTP %d with %d", resp.StatusCode, settings.DefaultPageSize)
	}

	// It has to survive as a stored option, not just in this response.
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	if settings.DefaultPageSize != 50 {
		t.Fatalf("setting did not persist: %d", settings.DefaultPageSize)
	}

	// Out-of-range values are refused rather than silently clamped: the list
	// endpoints cap page_size at 200, so a bigger default would be a lie.
	for _, size := range []int{0, 1, 201, -5} {
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin,
			consoleSettings{DefaultPageSize: size}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("page size %d was accepted (HTTP %d)", size, resp.StatusCode)
		}
	}

	// A regular user reads the setting but cannot change it.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "reader", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "reader", Password: "password123"}, &session)

	var asUser consoleSettings
	resp = h.do(http.MethodGet, "/api/settings", session.Token, nil, &asUser)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || asUser.DefaultPageSize != 50 {
		t.Fatalf("regular user read HTTP %d with %d", resp.StatusCode, asUser.DefaultPageSize)
	}

	resp = h.do(http.MethodPut, "/api/admin/settings", session.Token,
		consoleSettings{DefaultPageSize: 10}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user changed a global setting (HTTP %d)", resp.StatusCode)
	}
}

// The capture cap reaches 128 MiB, for conversations that carry many images,
// and stops there: past it, sanitising a body costs too much memory.
func TestLogBodyLimitCeiling(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct {
		limit int
		want  int
	}{
		{128 << 20, http.StatusOK},
		{128<<20 + 1, http.StatusBadRequest},
		{64<<10 - 1, http.StatusBadRequest},
	} {
		settings := h.settings(t)
		settings.LogBodyLimit = tc.limit
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
		resp.Body.Close()
		if resp.StatusCode != tc.want {
			t.Fatalf("limit %d: HTTP %d, want %d", tc.limit, resp.StatusCode, tc.want)
		}
	}
	if got := h.settings(t).LogBodyLimit; got != 128<<20 {
		t.Fatalf("stored limit %d, want 128 MiB", got)
	}
}

// The import defaults are what the channel form starts from, so they have to
// be readable before anything is configured and survive being changed.
func TestImportDefaultsRoundTrip(t *testing.T) {
	h := newHarness(t)

	var settings consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	if settings.ImportPriority != importPriorityFallback {
		t.Fatalf("import priority = %d, want %d",
			settings.ImportPriority, importPriorityFallback)
	}
	if settings.ImportWeight != importWeightFallback {
		t.Fatalf("import weight = %d, want %d", settings.ImportWeight, importWeightFallback)
	}

	settings.ImportPriority = 42
	settings.ImportWeight = 7
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, &settings)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update: HTTP %d, want 200", resp.StatusCode)
	}

	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	if settings.ImportPriority != 42 || settings.ImportWeight != 7 {
		t.Fatalf("import defaults did not persist: priority=%d weight=%d",
			settings.ImportPriority, settings.ImportWeight)
	}

	// A regular account reads them too: the channel form is admin-only, but the
	// settings endpoint is shared and must stay consistent.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "reader2", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "reader2", Password: "password123"}, &session)
	var asUser consoleSettings
	h.do(http.MethodGet, "/api/settings", session.Token, nil, &asUser)
	if asUser.ImportPriority != 42 || asUser.ImportWeight != 7 {
		t.Fatalf("regular user saw priority=%d weight=%d",
			asUser.ImportPriority, asUser.ImportWeight)
	}
}

// Weight is a share of the selection draw, so zero would create a channel that
// can never be picked. Refuse it rather than storing a value the form would
// silently correct later.
func TestImportDefaultsRejectUnusableValues(t *testing.T) {
	h := newHarness(t)

	var base consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &base)

	for _, tc := range []struct {
		name             string
		priority, weight int
	}{
		{"zero weight", 999, 0},
		{"negative weight", 999, -1},
		{"weight above the cap", 999, 1_000_001},
		{"priority above the cap", 1_000_001, 100},
		{"priority below the floor", -1_000_001, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := base
			in.ImportPriority = tc.priority
			in.ImportWeight = tc.weight
			resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, in, nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s was accepted: HTTP %d", tc.name, resp.StatusCode)
			}
		})
	}

	// None of the rejected attempts may have been written.
	var after consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &after)
	if after.ImportPriority != base.ImportPriority || after.ImportWeight != base.ImportWeight {
		t.Fatalf("a rejected update still changed the stored value: %+v", after)
	}
}

// The console's request timeout reaches the relay without a restart, and 0
// lifts it: a slow upstream fails under a one-second cap and answers without
// one. A channel's own timeout still wins over "no limit".
func TestRelayTimeoutFromSettings(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		time.Sleep(1500 * time.Millisecond)
		chatResponse(w, "late", 10, 5)
	})
	h.createChannel(channelInput{Name: "slow", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}})
	h.createChannel(channelInput{Name: "slow-capped", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o-mini"}, Groups: []string{"default"}, TimeoutSecs: 1})
	key := h.createKey()

	setTimeout := func(secs int) int {
		t.Helper()
		settings := h.consoleSettings(t)
		settings.RelayTimeoutSecs = secs
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
		resp.Body.Close()
		return resp.StatusCode
	}
	call := func(model string) int {
		t.Helper()
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"`+model+`"}`)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		return resp.StatusCode
	}

	if setTimeout(1) != http.StatusOK {
		t.Fatal("a 1-second timeout was refused")
	}
	if got := call("gpt-4o"); got == http.StatusOK {
		t.Fatal("a 1.5s upstream answered under a 1s timeout")
	}
	if setTimeout(0) != http.StatusOK || h.consoleSettings(t).RelayTimeoutSecs != 0 {
		t.Fatal("0 (no timeout) was not stored")
	}
	if got := call("gpt-4o"); got != http.StatusOK {
		t.Fatalf("with no timeout the call got HTTP %d", got)
	}
	if got := call("gpt-4o-mini"); got == http.StatusOK {
		t.Fatal("the channel's own 1s timeout did not apply under a global 0")
	}
	for _, bad := range []int{-1, maxRelayTimeoutSecs + 1} {
		if got := setTimeout(bad); got != http.StatusBadRequest {
			t.Fatalf("timeout %d accepted (HTTP %d)", bad, got)
		}
	}
}

// The console's stream idle limit reaches the relay without a restart: a
// stream that pauses 3s is cut under a one-second limit and runs to [DONE]
// once the limit is lifted.
func TestStreamIdleFromSettings(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n")
		flusher.Flush()

		// A tool call the upstream buffers whole: silence, then the rest.
		select {
		case <-time.After(3 * time.Second):
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"llo\"}}]}\n\ndata: [DONE]\n\n")
		flusher.Flush()
	})
	h.createChannel(channelInput{Name: "quiet", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}})
	key := h.createKey()

	setIdle := func(secs int) int {
		t.Helper()
		settings := h.consoleSettings(t)
		settings.StreamIdleSecs = secs
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
		resp.Body.Close()
		return resp.StatusCode
	}
	call := func() string {
		t.Helper()
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","stream":true}`)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return string(raw)
	}

	if setIdle(1) != http.StatusOK {
		t.Fatal("a 1-second idle limit was refused")
	}
	if got := call(); strings.Contains(got, "[DONE]") {
		t.Fatalf("a 3s pause survived a 1s idle limit: %s", got)
	}
	if entry := h.waitForLog(t, 1); !strings.Contains(entry.Error, "sent nothing for 1s") {
		t.Fatalf("idle cut logged as %q", entry.Error)
	}

	if setIdle(0) != http.StatusOK || h.consoleSettings(t).StreamIdleSecs != 0 {
		t.Fatal("0 (no idle limit) was not stored")
	}
	if got := call(); !strings.Contains(got, "[DONE]") {
		t.Fatalf("with no idle limit the stream was cut: %s", got)
	}

	for _, bad := range []int{-1, maxStreamIdleSecs + 1} {
		if got := setIdle(bad); got != http.StatusBadRequest {
			t.Fatalf("idle limit %d accepted (HTTP %d)", bad, got)
		}
	}
}
