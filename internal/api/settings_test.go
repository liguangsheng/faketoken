package api

import (
	"net/http"
	"testing"
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
