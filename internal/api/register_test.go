package api

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
)

func TestRegistrationQuotaFollowsTheSetting(t *testing.T) {
	h := newHarness(t)

	current := h.consoleSettings(t)
	current.InitQuotaUSD = 7.5
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, current, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update settings: HTTP %d", resp.StatusCode)
	}

	var registered sessionResponse
	resp = h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "newcomer", Password: "password123"}, &registered)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register: HTTP %d", resp.StatusCode)
	}
	if registered.User.Quota != billing.ParseUSD(7.5) {
		t.Fatalf("new account got %d micro-USD, want %d",
			registered.User.Quota, billing.ParseUSD(7.5))
	}
}

func TestRegistrationCanBeClosedFromSettings(t *testing.T) {
	h := newHarness(t)
	// The harness boots with AllowRegister: true, so this also proves the
	// stored setting beats the environment default.

	settings := h.consoleSettings(t)
	if !settings.AllowRegister {
		t.Fatal("the harness should start with registration open")
	}

	var status struct {
		AllowRegister bool `json:"allow_register"`
	}
	h.do(http.MethodGet, "/api/status", "", nil, &status)
	if !status.AllowRegister {
		t.Fatal("the public status endpoint should advertise open registration")
	}

	settings.AllowRegister = false
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, &settings)
	resp.Body.Close()
	if settings.AllowRegister {
		t.Fatal("the setting did not stick")
	}

	// No restart in between: the next attempt has to be refused.
	resp = h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "walkin", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("register: HTTP %d, want 403", resp.StatusCode)
	}

	// The login page has to stop offering the tab, or it invites a dead end.
	h.do(http.MethodGet, "/api/status", "", nil, &status)
	if status.AllowRegister {
		t.Fatal("the login page would still offer registration")
	}

	// Reopening works the same way round.
	settings.AllowRegister = true
	resp = h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "walkin", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("register after reopening: HTTP %d, want 201", resp.StatusCode)
	}
}

// createInvites generates a batch and returns the codes.
func (h *harness) createInvites(t *testing.T, count int) []string {
	t.Helper()
	var created struct {
		Data []model.InviteCode `json:"data"`
	}
	resp := h.do(http.MethodPost, "/api/admin/invites", h.admin,
		map[string]any{"name": "test", "count": count}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || len(created.Data) != count {
		t.Fatalf("create invites: HTTP %d with %d codes", resp.StatusCode, len(created.Data))
	}
	codes := make([]string, 0, count)
	for _, entry := range created.Data {
		codes = append(codes, entry.Code)
	}
	return codes
}

// requireInvites flips the setting, returning registration to open on cleanup.
func (h *harness) requireInvites(t *testing.T, required bool) {
	t.Helper()
	settings := h.settings(t)
	settings.RequireInviteCode = required
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set invite requirement: HTTP %d", resp.StatusCode)
	}
}

func TestRegistrationRequiresAnInviteWhenEnabled(t *testing.T) {
	h := newHarness(t)
	h.requireInvites(t, true)

	// The login page has to know, or it cannot render the field.
	var status struct {
		AllowRegister     bool `json:"allow_register"`
		RequireInviteCode bool `json:"require_invite_code"`
	}
	h.do(http.MethodGet, "/api/status", "", nil, &status)
	if !status.RequireInviteCode {
		t.Fatal("the status endpoint does not announce the invite requirement")
	}

	// Without a code.
	resp := h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "nocode", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("registration without a code: HTTP %d, want 400", resp.StatusCode)
	}

	// With a made-up one.
	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "faker", Password: "password123", InviteCode: "AAAAA-BBBBB-CCCCC-DDDDD",
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("registration with an unknown code: HTTP %d, want 400", resp.StatusCode)
	}

	// With a real one, typed carelessly: lower case and padded.
	code := h.createInvites(t, 1)[0]
	var session sessionResponse
	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "invited", Password: "password123",
		InviteCode: "  " + strings.ToLower(code) + " ",
	}, &session)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("registration with a valid code: HTTP %d, want 201", resp.StatusCode)
	}
	if session.User == nil || session.User.Username != "invited" {
		t.Fatalf("unexpected account: %+v", session.User)
	}

	// The same code cannot buy a second account.
	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "second", Password: "password123", InviteCode: code,
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("reusing a spent code: HTTP %d, want 409", resp.StatusCode)
	}

	// And the code records who spent it.
	var listed page[*model.InviteCode]
	h.do(http.MethodGet, "/api/admin/invites", h.admin, nil, &listed)
	if len(listed.Data) != 1 {
		t.Fatalf("expected 1 invite, got %d", len(listed.Data))
	}
	if listed.Data[0].Status != model.InviteUsed ||
		listed.Data[0].UsedByName != "invited" || listed.Data[0].UsedAt == nil {
		t.Fatalf("the invite does not record who used it: %+v", listed.Data[0])
	}
}

// The claim and the account creation share a transaction, so a signup that
// fails after the claim must give the invitation back. Without that, one
// mistyped username would silently consume a code.
func TestFailedSignupDoesNotBurnTheInvite(t *testing.T) {
	h := newHarness(t)
	h.requireInvites(t, true)
	code := h.createInvites(t, 1)[0]

	// admin already exists, so this signup fails on the username.
	resp := h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "admin", Password: "password123", InviteCode: code,
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate username: HTTP %d, want 409", resp.StatusCode)
	}

	var listed page[*model.InviteCode]
	h.do(http.MethodGet, "/api/admin/invites", h.admin, nil, &listed)
	if listed.Data[0].Status != model.InviteUnused {
		t.Fatalf("a failed signup consumed the invite: %+v", listed.Data[0])
	}

	// It still works afterwards, which is the point.
	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "later", Password: "password123", InviteCode: code,
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("the returned invite no longer works: HTTP %d", resp.StatusCode)
	}
}

// One code, one account, even when several people submit it at the same
// instant. The claim is a single UPDATE for exactly this reason.
func TestConcurrentSignupsSpendAnInviteOnce(t *testing.T) {
	h := newHarness(t)
	h.requireInvites(t, true)
	code := h.createInvites(t, 1)[0]

	const attempts = 8
	var created, refused atomic.Int64
	var wg sync.WaitGroup
	wg.Add(attempts)
	for i := range attempts {
		go func(n int) {
			defer wg.Done()
			resp := h.do(http.MethodPost, "/api/auth/register", "", credentials{
				Username:   fmt.Sprintf("racer-%d", n),
				Password:   "password123",
				InviteCode: code,
			}, nil)
			resp.Body.Close()
			switch resp.StatusCode {
			case http.StatusCreated:
				created.Add(1)
			case http.StatusConflict, http.StatusBadRequest:
				refused.Add(1)
			default:
				t.Errorf("unexpected status %d", resp.StatusCode)
			}
		}(i)
	}
	wg.Wait()

	if created.Load() != 1 {
		t.Fatalf("%d accounts were created from one invite", created.Load())
	}
	if refused.Load() != attempts-1 {
		t.Fatalf("%d refusals, want %d", refused.Load(), attempts-1)
	}
}

// Turning the requirement off has to restore open registration immediately,
// without a restart and without needing a code.
func TestRegistrationNeedsNoInviteWhenDisabled(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "walkin", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("open registration: HTTP %d, want 201", resp.StatusCode)
	}

	h.requireInvites(t, true)
	resp = h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "blocked", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("after enabling: HTTP %d, want 400", resp.StatusCode)
	}

	h.requireInvites(t, false)
	resp = h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "walkin2", Password: "password123"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("after disabling: HTTP %d, want 201", resp.StatusCode)
	}
}

// A disabled code is refused, and a spent one is kept as the record of which
// invitation an account came from.
func TestInviteStatusAndDeletion(t *testing.T) {
	h := newHarness(t)
	h.requireInvites(t, true)
	codes := h.createInvites(t, 3)

	var listed page[*model.InviteCode]
	h.do(http.MethodGet, "/api/admin/invites", h.admin, nil, &listed)

	// Disable the first, then try to use it.
	resp := h.do(http.MethodPut,
		fmt.Sprintf("/api/admin/invites/%d/status", listed.Data[0].ID), h.admin,
		map[string]any{"status": model.InviteDisabled}, nil)
	resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "denied", Password: "password123", InviteCode: listed.Data[0].Code,
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("disabled invite: HTTP %d, want 403", resp.StatusCode)
	}

	// Spend another one.
	resp = h.do(http.MethodPost, "/api/auth/register", "", credentials{
		Username: "used-one", Password: "password123", InviteCode: codes[1],
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("valid invite: HTTP %d", resp.StatusCode)
	}

	// Delete everything; the spent one has to survive.
	ids := make([]int64, 0, len(listed.Data))
	for _, entry := range listed.Data {
		ids = append(ids, entry.ID)
	}
	var result struct {
		Deleted int64 `json:"deleted"`
	}
	resp = h.do(http.MethodPost, "/api/admin/invites/delete", h.admin,
		map[string]any{"ids": ids}, &result)
	resp.Body.Close()
	if result.Deleted != 2 {
		t.Fatalf("deleted %d, want 2 — the spent invite must be kept", result.Deleted)
	}

	h.do(http.MethodGet, "/api/admin/invites", h.admin, nil, &listed)
	if len(listed.Data) != 1 || listed.Data[0].UsedByName != "used-one" {
		t.Fatalf("the wrong invite survived: %+v", listed.Data)
	}
}

// The codes are the whole point of the feature; a regular account must not be
// able to read or mint them.
func TestInviteCodesAreAdminOnly(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "peon2", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "peon2", Password: "password123"}, &session)

	for _, tc := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/invites"},
		{http.MethodPost, "/api/admin/invites"},
		{http.MethodPost, "/api/admin/invites/delete"},
	} {
		resp := h.do(tc.method, tc.path, session.Token, map[string]any{"count": 1}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Fatalf("%s %s: HTTP %d, want 403", tc.method, tc.path, resp.StatusCode)
		}
	}
}
