package api

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// A group carries channel access and a price multiplier, so the server has to
// be the thing that decides which one a key may name.
func TestTokenKeyCanBeRevealedByItsOwnerOnly(t *testing.T) {
	h := newHarness(t)

	var created struct {
		Token model.Token `json:"token"`
		Key   string      `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "copyable", UnlimitedQuota: true}, &created)
	resp.Body.Close()

	// The stored ciphertext has to round-trip to exactly what was handed out.
	var revealed struct {
		Key string `json:"key"`
	}
	resp = h.do(http.MethodGet, fmt.Sprintf("/api/tokens/%d/key", created.Token.ID),
		h.admin, nil, &revealed)
	resp.Body.Close()
	if revealed.Key != created.Key {
		t.Fatalf("revealed %q, want the key issued at creation", revealed.Key)
	}

	// And it still authenticates, so what was copied actually works.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", revealed.Key,
		`{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	if relayed.StatusCode != http.StatusOK {
		t.Fatalf("the revealed key does not work: HTTP %d", relayed.StatusCode)
	}

	// Another account must not be able to read it.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "nosy", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "nosy", Password: "password123"}, &session)

	resp = h.do(http.MethodGet, fmt.Sprintf("/api/tokens/%d/key", created.Token.ID),
		session.Token, nil, nil)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("another user read the key: HTTP %d", resp.StatusCode)
	}
	if strings.Contains(string(raw), created.Key) {
		t.Fatalf("the key leaked in the error body: %s", raw)
	}

	// A listing must never carry plaintext, however often it is fetched.
	var listed page[*model.Token]
	resp = h.do(http.MethodGet, "/api/tokens", h.admin, nil, &listed)
	body, _ := json.Marshal(listed)
	resp.Body.Close()
	if strings.Contains(string(body), created.Key) {
		t.Fatalf("the token list exposed a plaintext key: %s", body)
	}
}

// A hand-written key must work end to end: stored, recoverable, and accepted
// by the relay exactly as typed.
func TestCustomTokenKeyIsUsedVerbatim(t *testing.T) {
	h := newHarness(t)
	const custom = "my-own-key-that-is-long-enough"

	var created struct {
		Token model.Token `json:"token"`
		Key   string      `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "custom", UnlimitedQuota: true, Key: custom}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("create: HTTP %d, want 201", resp.StatusCode)
	}
	if created.Key != custom {
		t.Fatalf("issued %q, want the requested key %q", created.Key, custom)
	}

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", custom,
		`{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	if relayed.StatusCode != http.StatusOK {
		t.Fatalf("the custom key does not authenticate: HTTP %d", relayed.StatusCode)
	}
}

// The confirmation has to bind on the server. A dialog in the console is a
// courtesy; this endpoint is reachable with curl.
func TestShortTokenKeyNeedsExplicitConfirmation(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "short", UnlimitedQuota: true, Key: "abc123"}, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unconfirmed short key: HTTP %d, want 400", resp.StatusCode)
	}
	if !strings.Contains(string(body), "16") {
		t.Fatalf("the error should say what the minimum is: %s", body)
	}

	// Nothing may have been written by the rejected attempt.
	var listed page[*model.Token]
	resp = h.do(http.MethodGet, "/api/tokens", h.admin, nil, &listed)
	resp.Body.Close()
	for _, tok := range listed.Data {
		if tok.Name == "short" {
			t.Fatal("a rejected key was created anyway")
		}
	}

	// With the acknowledgement it goes through.
	var created struct {
		Key string `json:"key"`
	}
	resp = h.do(http.MethodPost, "/api/tokens", h.admin, tokenInput{
		Name: "short", UnlimitedQuota: true, Key: "abc123", ConfirmWeakKey: true,
	}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("confirmed short key: HTTP %d, want 201", resp.StatusCode)
	}
	if created.Key != "abc123" {
		t.Fatalf("issued %q, want abc123", created.Key)
	}
}

// key_prefix is shown in listings, so a short key must not be fully legible
// there — otherwise the list becomes a set of working credentials.
func TestShortTokenKeyIsNotLegibleInListings(t *testing.T) {
	h := newHarness(t)
	const short = "abc123"

	resp := h.do(http.MethodPost, "/api/tokens", h.admin, tokenInput{
		Name: "short", UnlimitedQuota: true, Key: short, ConfirmWeakKey: true,
	}, nil)
	resp.Body.Close()

	var listed page[*model.Token]
	resp = h.do(http.MethodGet, "/api/tokens", h.admin, nil, &listed)
	resp.Body.Close()
	body, _ := json.Marshal(listed)
	if strings.Contains(string(body), short) {
		t.Fatalf("a short key is readable in the listing: %s", body)
	}
}

// Two keys cannot share a secret: the second attempt must be refused clearly,
// not with a raw constraint violation.
func TestDuplicateTokenKeyIsRejected(t *testing.T) {
	h := newHarness(t)
	const key = "shared-key-long-enough-1"

	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "first", UnlimitedQuota: true, Key: key}, nil)
	resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "second", UnlimitedQuota: true, Key: key}, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate key: HTTP %d, want 409", resp.StatusCode)
	}
	if strings.Contains(string(body), "SQLSTATE") {
		t.Fatalf("the raw constraint violation leaked: %s", body)
	}
}

// Editing the key must actually rotate the credential: the old one stops
// working the moment the new one is saved.
func TestEditingATokenKeyRevokesTheOldOne(t *testing.T) {
	h := newHarness(t)

	var created struct {
		Token model.Token `json:"token"`
		Key   string      `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "rotating", UnlimitedQuota: true}, &created)
	resp.Body.Close()

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	const replacement = "rotated-key-long-enough"
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/tokens/%d", created.Token.ID), h.admin,
		tokenInput{Name: "rotating", UnlimitedQuota: true, Key: replacement}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("update: HTTP %d, want 200", resp.StatusCode)
	}

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", replacement,
		`{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	if relayed.StatusCode != http.StatusOK {
		t.Fatalf("the new key does not work: HTTP %d", relayed.StatusCode)
	}

	relayed = h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key,
		`{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	if relayed.StatusCode == http.StatusOK {
		t.Fatal("the replaced key still authenticates")
	}

	// The recovery endpoint has to follow the rotation, not serve the old
	// ciphertext.
	var revealed struct {
		Key string `json:"key"`
	}
	resp = h.do(http.MethodGet, fmt.Sprintf("/api/tokens/%d/key", created.Token.ID),
		h.admin, nil, &revealed)
	resp.Body.Close()
	if revealed.Key != replacement {
		t.Fatalf("revealed %q, want the rotated key", revealed.Key)
	}
}

// Saving an unrelated field must not disturb the secret, so the edit form
// never has to round-trip it.
func TestEditingWithoutAKeyLeavesItUntouched(t *testing.T) {
	h := newHarness(t)

	var created struct {
		Token model.Token `json:"token"`
		Key   string      `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "stable", UnlimitedQuota: true}, &created)
	resp.Body.Close()

	resp = h.do(http.MethodPut, fmt.Sprintf("/api/tokens/%d", created.Token.ID), h.admin,
		tokenInput{Name: "renamed", UnlimitedQuota: true}, nil)
	resp.Body.Close()

	var revealed struct {
		Key string `json:"key"`
	}
	resp = h.do(http.MethodGet, fmt.Sprintf("/api/tokens/%d/key", created.Token.ID),
		h.admin, nil, &revealed)
	resp.Body.Close()
	if revealed.Key != created.Key {
		t.Fatalf("the key changed on an unrelated edit: %q became %q",
			created.Key, revealed.Key)
	}
}

// A key travels in an HTTP header; whitespace and control characters would be
// mangled or split the header, so they are refused whatever the length.
func TestMalformedCustomKeysAreRejected(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct{ name, key string }{
		{"space", "has a space in it here"},
		{"tab", "has\ttab\tcharacters\there"},
		{"newline", "line\nbreak\nin\nthe\nkey"},
		{"control", "control\x01character\x01here"},
		{"too long", strings.Repeat("k", 201)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			resp := h.do(http.MethodPost, "/api/tokens", h.admin, tokenInput{
				Name: tc.name, UnlimitedQuota: true, Key: tc.key, ConfirmWeakKey: true,
			}, nil)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("%s: HTTP %d, want 400", tc.name, resp.StatusCode)
			}
		})
	}
}

// Keys created before encrypted storage cannot be recovered; say so plainly
// instead of returning an empty string that looks like a key.
func TestLegacyTokenReportsThatItCannotBeRevealed(t *testing.T) {
	h := newHarness(t)

	var created struct {
		Token model.Token `json:"token"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "legacy", UnlimitedQuota: true}, &created)
	resp.Body.Close()

	// Simulate a row written before this migration.
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE tokens SET key_enc = '' WHERE id = $1`, created.Token.ID); err != nil {
		t.Fatal(err)
	}

	resp = h.do(http.MethodGet, fmt.Sprintf("/api/tokens/%d/key", created.Token.ID),
		h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusGone {
		t.Fatalf("legacy key: HTTP %d, want 410", resp.StatusCode)
	}
}

func TestTokenGroupIsAuthorisedServerSide(t *testing.T) {
	h := newHarness(t)

	// "premium" stays closed; "shared" is opened to everyone.
	for _, group := range []map[string]any{
		{"name": "premium", "rate": 0.1, "description": "closed"},
		{"name": "shared", "rate": 1, "description": "open", "user_selectable": true},
	} {
		resp := h.do(http.MethodPost, "/api/admin/groups", h.admin, group, nil)
		resp.Body.Close()
	}

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "peon", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "peon", Password: "password123"}, &session)

	// Refused: a closed group would hand out both a cheaper rate and access to
	// channels the account was never given.
	resp := h.do(http.MethodPost, "/api/tokens", session.Token,
		tokenInput{Name: "sneaky", Group: "premium", UnlimitedQuota: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("closed group accepted: HTTP %d, want 403", resp.StatusCode)
	}

	// A group that does not exist at all is a bad request, not a 403.
	resp = h.do(http.MethodPost, "/api/tokens", session.Token,
		tokenInput{Name: "typo", Group: "no-such-group", UnlimitedQuota: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown group: HTTP %d, want 400", resp.StatusCode)
	}

	// Allowed: an opened group, and the account's own group.
	var created struct {
		Token model.Token `json:"token"`
	}
	resp = h.do(http.MethodPost, "/api/tokens", session.Token,
		tokenInput{Name: "shared-key", Group: "shared", UnlimitedQuota: true}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || created.Token.Group != "shared" {
		t.Fatalf("open group refused: HTTP %d group=%q", resp.StatusCode, created.Token.Group)
	}

	// Editing an existing key must run the same check, or the create-then-edit
	// path walks straight around it.
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/tokens/%d", created.Token.ID), session.Token,
		tokenInput{Name: "shared-key", Group: "premium", UnlimitedQuota: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("update to a closed group: HTTP %d, want 403", resp.StatusCode)
	}

	// The console is offered exactly what the server accepts.
	var offered struct {
		Data []model.UserGroup `json:"data"`
		Own  string            `json:"own"`
	}
	h.do(http.MethodGet, "/api/me/groups", session.Token, nil, &offered)
	names := make([]string, 0, len(offered.Data))
	for _, group := range offered.Data {
		names = append(names, group.Name)
	}
	sort.Strings(names)
	if !slices.Equal(names, []string{"default", "shared"}) {
		t.Fatalf("offered groups = %v, want [default shared]", names)
	}

	// An administrator is not restricted: they already control groups outright.
	resp = h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "admin-key", Group: "premium", UnlimitedQuota: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("admin refused a closed group: HTTP %d", resp.StatusCode)
	}
}

// The key's group has to drive both halves: it picks the channel pool and it
// prices the result.
func TestTokenGroupDrivesRoutingAndBilling(t *testing.T) {
	h := newHarness(t)

	cheap := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-shared", 1000, 0)
	})
	h.do(http.MethodPost, "/api/admin/groups", h.admin, map[string]any{
		"name": "shared", "rate": 0.5, "description": "half price", "user_selectable": true,
	}, nil)
	h.createChannel(channelInput{
		Name: "shared-only", Type: "openai", BaseURL: cheap.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"shared"},
	})

	// A key with no group follows the account, which cannot reach that pool.
	plain := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", plain, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("default group reached a shared-only channel: HTTP %d", resp.StatusCode)
	}

	var created struct {
		Key string `json:"key"`
	}
	h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "shared", Group: "shared", UnlimitedQuota: true}, &created)

	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("the shared key could not reach its own pool: HTTP %d", resp.StatusCode)
	}

	// Both requests are logged, and the refused one lands first; pick the
	// relayed request rather than whichever row happened to be written first.
	h.waitForLog(t, 2)
	entry := h.logByStatus(t, http.StatusOK)

	// gpt-4o input is $2.50/1M, so 1000 tokens at the group's 0.5 rate is
	// 1250 micro-USD. Billing at the account's group would have charged 2500.
	if entry.Cost != 1250 {
		t.Fatalf("cost = %d micro-USD, want 1250 (the key's group rate)", entry.Cost)
	}
}
