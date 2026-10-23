package api

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/model"
)

func (h *harness) meStatus(token string) int {
	h.t.Helper()
	resp := h.do(http.MethodGet, "/api/me", token, nil, nil)
	resp.Body.Close()
	return resp.StatusCode
}

// A leaked session has to die with the password it was issued under, and the
// device that made the change must not be thrown out with it.
func TestPasswordChangeEndsOtherSessions(t *testing.T) {
	h := newHarness(t)
	elsewhere := h.login("admin", "admin-password")

	var changed struct {
		Token string `json:"token"`
	}
	resp := h.do(http.MethodPut, "/api/me/password", h.admin, map[string]string{
		"old_password": "admin-password", "new_password": "brand-new-password",
	}, &changed)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || changed.Token == "" {
		t.Fatalf("password change: HTTP %d, token %q", resp.StatusCode, changed.Token)
	}

	if got := h.meStatus(elsewhere); got != http.StatusUnauthorized {
		t.Fatalf("a session from before the change: HTTP %d, want 401", got)
	}
	if got := h.meStatus(h.admin); got != http.StatusUnauthorized {
		t.Fatalf("the token the change was made with: HTTP %d, want 401", got)
	}
	if got := h.meStatus(changed.Token); got != http.StatusOK {
		t.Fatalf("the replacement token: HTTP %d, want 200", got)
	}
	h.login("admin", "brand-new-password")
}

func TestAdminResetEndsTheAccountsSessions(t *testing.T) {
	h := newHarness(t)

	var registered sessionResponse
	resp := h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "member", Password: "password123"}, &registered)
	resp.Body.Close()
	if got := h.meStatus(registered.Token); got != http.StatusOK {
		t.Fatalf("fresh session: HTTP %d", got)
	}

	resp = h.do(http.MethodPut, fmt.Sprintf("/api/admin/users/%d/password", registered.User.ID),
		h.admin, map[string]string{"password": "reset-by-admin"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("reset: HTTP %d", resp.StatusCode)
	}
	if got := h.meStatus(registered.Token); got != http.StatusUnauthorized {
		t.Fatalf("a session from before the reset: HTTP %d, want 401", got)
	}
	// Someone else's reset leaves the administrator signed in.
	if got := h.meStatus(h.admin); got != http.StatusOK {
		t.Fatalf("the administrator's own session: HTTP %d, want 200", got)
	}
}

// Tokens minted before versions existed carry none; they must keep working
// until the password next changes, or the deploy would sign everyone out.
func TestTokensWithoutAVersionStillWork(t *testing.T) {
	h := newHarness(t)
	admin, err := h.store.GetUserByUsername(context.Background(), "admin")
	if err != nil {
		t.Fatal(err)
	}
	legacy, _, err := auth.NewJWTManager([]byte("test-secret"), time.Hour).
		Issue(admin.ID, admin.Role, admin.Username, 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := h.meStatus(legacy); got != http.StatusOK {
		t.Fatalf("a version-0 token on an unchanged account: HTTP %d, want 200", got)
	}
}

// The live log feed is authenticated once, when it opens, and then runs for
// hours; this is what ends it once the password changes.
func TestStreamingSessionEndsWithThePassword(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	me, err := h.store.GetUserByUsername(ctx, "admin")
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{store: h.store}

	if !s.sessionStillValid(ctx, me) {
		t.Fatal("an untouched session was judged invalid")
	}
	hash, _ := auth.HashPassword("brand-new-password")
	if _, err := h.store.UpdateUserPassword(ctx, me.ID, hash); err != nil {
		t.Fatal(err)
	}
	if s.sessionStillValid(ctx, me) {
		t.Fatal("the feed would outlive the password change")
	}

	demoted := *me
	demoted.Role = model.RoleUser
	if s.sessionStillValid(ctx, &demoted) {
		t.Fatal("the feed would outlive a change of role")
	}
}

// Unreadable switches must read as closed. Falling back to the environment
// default would open registration whenever the database stumbles.
func TestRegistrationSwitchesFailClosed(t *testing.T) {
	h := newHarness(t)
	s := &Server{store: h.store, cfg: &config.Config{AllowRegister: true}}

	broken, cancel := context.WithCancel(context.Background())
	cancel()
	if open, err := s.allowRegister(broken); err == nil || open {
		t.Fatalf("allowRegister on a failed read = %v, %v; want false and an error", open, err)
	}
	if _, err := s.requireInviteCode(broken); err == nil {
		t.Fatal("requireInviteCode on a failed read reported no error")
	}

	// A missing row is not a failure: it means the default.
	if open, err := s.allowRegister(context.Background()); err != nil || !open {
		t.Fatalf("allowRegister with the row absent = %v, %v; want the default", open, err)
	}
}
