package api

import (
	"context"
	"crypto/sha256"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/store"
)

const sealed = "enc:v1:"

func TestChannelCredentialsAreEncryptedAtRest(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	id := h.createChannel(channelInput{
		Name: "sealed", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers: map[string]string{
			"Authorization": "Token stored-secret-0123456789",
			"User-Agent":    "custom/1.0",
		},
		ProxyURL: "http://user:hunter2@proxy.local:8080",
	})

	// What a dump or a stray SELECT would see.
	var authValue, userAgent, proxy string
	if err := h.pool.QueryRow(ctx, `SELECT headers->>'Authorization', headers->>'User-Agent', proxy_url
		FROM channels WHERE id = $1`, id).Scan(&authValue, &userAgent, &proxy); err != nil {
		t.Fatal(err)
	}
	for _, stored := range []string{authValue, proxy} {
		if !strings.HasPrefix(stored, sealed) ||
			strings.Contains(stored, "stored-secret") || strings.Contains(stored, "hunter2") {
			t.Fatalf("a credential is stored in the clear: %q", stored)
		}
	}
	if userAgent != "custom/1.0" {
		t.Fatalf("an ordinary header was encrypted: %q", userAgent)
	}

	// Everything above the store still works with the plain values.
	ch, err := h.store.GetChannel(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.Headers["Authorization"] != "Token stored-secret-0123456789" ||
		ch.ProxyURL != "http://user:hunter2@proxy.local:8080" {
		t.Fatalf("the store did not decrypt what it wrote: %+v %q", ch.Headers, ch.ProxyURL)
	}
}

// Rows saved before the store encrypted anything are sealed at boot, once.
func TestBootSealsCredentialsStoredInTheClear(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	id := h.createChannel(channelInput{
		Name: "legacy", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	if _, err := h.pool.Exec(ctx, `UPDATE channels
		SET headers = '{"X-Api-Key": "plain-secret", "User-Agent": "ua/1"}',
		    proxy_url = 'http://u:p@proxy.local:1'
		WHERE id = $1`, id); err != nil {
		t.Fatal(err)
	}

	count, err := h.store.SealChannelSecrets(ctx)
	if err != nil || count != 1 {
		t.Fatalf("sealed %d channel(s), err %v; want 1", count, err)
	}
	var key, userAgent, proxy string
	if err := h.pool.QueryRow(ctx, `SELECT headers->>'X-Api-Key', headers->>'User-Agent', proxy_url
		FROM channels WHERE id = $1`, id).Scan(&key, &userAgent, &proxy); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, sealed) || !strings.HasPrefix(proxy, sealed) || userAgent != "ua/1" {
		t.Fatalf("after sealing: key %q, user-agent %q, proxy %q", key, userAgent, proxy)
	}
	ch, err := h.store.GetChannel(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.Headers["X-Api-Key"] != "plain-secret" || ch.ProxyURL != "http://u:p@proxy.local:1" {
		t.Fatalf("sealed values do not read back: %+v %q", ch.Headers, ch.ProxyURL)
	}

	if again, err := h.store.SealChannelSecrets(ctx); err != nil || again != 0 {
		t.Fatalf("a second pass rewrote %d channel(s), err %v", again, err)
	}
}

// A changed ENCRYPTION_KEY must not take the channel list down with it: the
// values it can no longer read come back empty, as the API key does.
func TestCredentialsUnderAnotherKeyReadAsEmpty(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	id := h.createChannel(channelInput{
		Name: "rotated", BaseURL: "https://upstream.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers:  map[string]string{"Authorization": "Token x", "User-Agent": "ua/1"},
		ProxyURL: "http://u:p@proxy.local:1",
	})

	other, err := auth.NewCipher(sha256.Sum256([]byte("another key")))
	if err != nil {
		t.Fatal(err)
	}
	ch, err := store.New(h.pool, other).GetChannel(ctx, id)
	if err != nil {
		t.Fatalf("a channel under another key no longer reads: %v", err)
	}
	if ch.Headers["Authorization"] != "" || ch.ProxyURL != "" || ch.Headers["User-Agent"] != "ua/1" {
		t.Fatalf("under another key: %+v %q", ch.Headers, ch.ProxyURL)
	}
}

// The suite connects as the role the server deploys with, so a migration that
// needs a superuser fails here rather than on the next boot in production.
func TestSuiteRunsWithoutSuperuser(t *testing.T) {
	h := newHarness(t)
	var super bool
	if err := h.pool.QueryRow(context.Background(),
		`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`).Scan(&super); err != nil {
		t.Fatal(err)
	}
	if super {
		t.Fatal("the integration suite is connected as a superuser")
	}
}
