package api

import (
	"fmt"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// guardAt returns a guard whose clock only moves when the test moves it.
func guardAt(start time.Time) (*attemptGuard, func(time.Duration)) {
	now := start
	g := newAttemptGuard()
	g.now = func() time.Time { return now }
	return g, func(d time.Duration) { now = now.Add(d) }
}

func TestGuardLocksOnTheFifthFailure(t *testing.T) {
	g, advance := guardAt(time.Unix(1_000_000, 0))

	for i := 1; i < guardLockAfter; i++ {
		if lock := g.fail("k"); lock != 0 {
			t.Fatalf("failure %d locked the key for %v", i, lock)
		}
	}
	if wait := g.wait("k"); wait != 0 {
		t.Fatalf("locked after %d free mistakes: %v", guardLockAfter-1, wait)
	}

	if lock := g.fail("k"); lock != guardBaseLock {
		t.Fatalf("failure %d: lock %v, want %v", guardLockAfter, lock, guardBaseLock)
	}
	if wait := g.wait("k"); wait != guardBaseLock {
		t.Fatalf("wait %v, want %v", wait, guardBaseLock)
	}
	if wait := g.wait("other"); wait != 0 {
		t.Fatalf("an unrelated key is locked too: %v", wait)
	}

	advance(guardBaseLock)
	if wait := g.wait("k"); wait != 0 {
		t.Fatalf("still locked once the lock ran out: %v", wait)
	}
}

func TestGuardLockDoublesUpToTheCeiling(t *testing.T) {
	g, advance := guardAt(time.Unix(1_000_000, 0))
	for range guardLockAfter - 1 {
		g.fail("k")
	}

	// Each failure lands after the previous lock ran out, the way a patient
	// guesser would send them.
	want := []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute,
		8 * time.Minute, guardMaxLock, guardMaxLock}
	for i, expected := range want {
		lock := g.fail("k")
		if lock != expected {
			t.Fatalf("failure %d: lock %v, want %v", guardLockAfter+i, lock, expected)
		}
		advance(lock)
	}
}

// Someone who gets the password right has proved they know it; their earlier
// typos must not still count towards a lock.
func TestGuardSuccessForgetsTheCount(t *testing.T) {
	g, _ := guardAt(time.Unix(1_000_000, 0))
	for range guardLockAfter - 1 {
		g.fail("k")
	}
	g.succeed("k")

	for i := 1; i < guardLockAfter; i++ {
		if lock := g.fail("k"); lock != 0 {
			t.Fatalf("failure %d after a success locked the key for %v", i, lock)
		}
	}
}

func TestGuardForgetsQuietKeys(t *testing.T) {
	g, advance := guardAt(time.Unix(1_000_000, 0))
	for range guardLockAfter - 1 {
		g.fail("old")
	}

	advance(guardForgetAfter + time.Second)
	if lock := g.fail("old"); lock != 0 {
		t.Fatalf("an hour-old count still applied: locked for %v", lock)
	}

	// The sweep runs on writes; a key nobody has failed with in an hour is
	// gone from memory, not merely ignored.
	g.fail("seed")
	advance(guardForgetAfter + time.Minute)
	g.fail("fresh")
	if _, kept := g.keys["seed"]; kept {
		t.Fatal("the sweep kept a key quiet for over an hour")
	}
	if _, kept := g.keys["fresh"]; !kept {
		t.Fatal("the sweep dropped the key it was called for")
	}
}

func TestUserGuardKeyIsCaseInsensitiveAndBounded(t *testing.T) {
	if userGuardKey(" Admin ") != userGuardKey("admin") {
		t.Fatal("case and padding produce different counters for one account")
	}
	long := make([]byte, 1<<20)
	for i := range long {
		long[i] = 'a'
	}
	if n := len(userGuardKey(string(long))); n > 80 {
		t.Fatalf("a 1 MiB username produced a %d-byte key", n)
	}
}

// ---------------------------------------------------------------- over HTTP

func (h *harness) postLogin(username, password string) *http.Response {
	h.t.Helper()
	resp := h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: username, Password: password}, nil)
	resp.Body.Close()
	return resp
}

func requireLocked(t *testing.T, resp *http.Response, what string) {
	t.Helper()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("%s: HTTP %d, want 429", what, resp.StatusCode)
	}
	if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err != nil || seconds <= 0 {
		t.Fatalf("%s: Retry-After %q is not a positive number of seconds",
			what, resp.Header.Get("Retry-After"))
	}
}

func TestLoginLocksAfterRepeatedFailures(t *testing.T) {
	h := newHarness(t)

	for i := 1; i <= guardLockAfter; i++ {
		if resp := h.postLogin("admin", "wrong-password"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("attempt %d: HTTP %d, want 401", i, resp.StatusCode)
		}
	}

	// The lock is checked before the password, so even the right one is turned
	// away: otherwise the lock would only slow down wrong guesses.
	requireLocked(t, h.postLogin("admin", "admin-password"), "correct password while locked")
}

// An unknown username has to be charged exactly like a wrong password, or the
// lock itself would reveal which names exist. Spread over many names, the
// failures still land on the caller's address.
func TestUnknownUsernamesLockTheCaller(t *testing.T) {
	h := newHarness(t)

	for i := 1; i <= guardLockAfter; i++ {
		name := fmt.Sprintf("nobody-%d", i)
		if resp := h.postLogin(name, "password123"); resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("unknown user %s: HTTP %d, want 401", name, resp.StatusCode)
		}
	}
	requireLocked(t, h.postLogin("admin", "admin-password"), "login from a locked address")
}

func TestSignupGuessesLockTheCaller(t *testing.T) {
	h := newHarness(t)
	h.requireInvites(t, true)
	spent := h.createInvites(t, 1)[0]
	register := func(username, code string) *http.Response {
		resp := h.do(http.MethodPost, "/api/auth/register", "", credentials{
			Username: username, Password: "password123", InviteCode: code,
		}, nil)
		resp.Body.Close()
		return resp
	}
	if resp := register("first", spent); resp.StatusCode != http.StatusCreated {
		t.Fatalf("valid invite: HTTP %d", resp.StatusCode)
	}

	// A spent code was real: retrying it is not guessing, and is not charged.
	for i := 1; i <= guardLockAfter; i++ {
		if resp := register(fmt.Sprintf("late-%d", i), spent); resp.StatusCode != http.StatusConflict {
			t.Fatalf("spent invite, attempt %d: HTTP %d, want 409", i, resp.StatusCode)
		}
	}

	for i := 1; i <= guardLockAfter; i++ {
		code := fmt.Sprintf("AAAAA-BBBBB-CCCCC-%05d", i)
		if resp := register(fmt.Sprintf("guess-%d", i), code); resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("made-up invite %d: HTTP %d, want 400", i, resp.StatusCode)
		}
	}
	fresh := h.createInvites(t, 1)[0]
	requireLocked(t, register("patient", fresh), "valid invite from a locked address")
}

// A stolen session must not turn the password form into an unthrottled way to
// guess the password, and the lock it earns is the account's, login included.
func TestPasswordChangeSharesTheAccountLock(t *testing.T) {
	h := newHarness(t)

	change := func(old string) *http.Response {
		resp := h.do(http.MethodPut, "/api/me/password", h.admin, map[string]string{
			"old_password": old, "new_password": "brand-new-password",
		}, nil)
		resp.Body.Close()
		return resp
	}
	for i := 1; i <= guardLockAfter; i++ {
		if resp := change("not-it"); resp.StatusCode != http.StatusForbidden {
			t.Fatalf("wrong current password %d: HTTP %d, want 403", i, resp.StatusCode)
		}
	}
	requireLocked(t, change("admin-password"), "password change while locked")
	requireLocked(t, h.postLogin("admin", "admin-password"), "login to the locked account")
}
