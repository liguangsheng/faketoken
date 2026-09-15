// End-to-end tests covering sign-in, channel management, model pulling,
// priority routing, transparent passthrough, streaming and billing.
//
// Every harness drops and recreates the public schema, so these run against a
// dedicated throwaway Postgres — a separate container on its own port with
// tmpfs storage, not another database on the deployment cluster. newHarness
// verifies it reached that instance before touching anything.
//
//	make test-integration
package api

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/db"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

// ------------------------------------------------------------------ harness

type harness struct {
	t      *testing.T
	server *httptest.Server
	store  *store.Store
	pool   *pgxpool.Pool
	admin  string // session token
}

// testClusterName is set by the postgres-test service in docker-compose.yml.
// The deployment cluster leaves cluster_name empty, so reading it back
// identifies which server answered. A database name proves nothing on its own
// — anything can be created alongside the real data under any name.
const testClusterName = "faketoken-test"

// requireTestDatabase rejects a DSN whose database name is not suffixed
// "_test". This runs before dialling so the common mistake reports without a
// connection attempt; requireTestInstance is what actually pins the server.
func requireTestDatabase(dsn string) error {
	u, err := url.Parse(dsn)
	if err != nil {
		return fmt.Errorf("parse TEST_DATABASE_URL: %w", err)
	}
	name := strings.TrimPrefix(u.Path, "/")
	if !strings.HasSuffix(name, "_test") {
		return fmt.Errorf("TEST_DATABASE_URL names database %q; the suite drops the "+
			"public schema, so it only runs against a database suffixed \"_test\"", name)
	}
	return nil
}

// requireTestInstance confirms the pool reached the throwaway cluster and not
// the deployment one, which the database name alone cannot establish.
func requireTestInstance(ctx context.Context, pool *pgxpool.Pool) error {
	var name string
	if err := pool.QueryRow(ctx, "SHOW cluster_name").Scan(&name); err != nil {
		return fmt.Errorf("read cluster_name: %w", err)
	}
	if name != testClusterName {
		return fmt.Errorf("connected to cluster %q, want %q; start the throwaway "+
			"instance with `make test-db` and point TEST_DATABASE_URL at it", name, testClusterName)
	}
	return nil
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set TEST_DATABASE_URL to run the integration tests")
	}
	// The reset below is unrecoverable, and the deployment DSN differs from a
	// test one only by the database name — easy to paste by accident, and the
	// damage is silent because the suite then passes against real data.
	if err := requireTestDatabase(dsn); err != nil {
		t.Fatalf("refusing to run: %v", err)
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx, dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(pool.Close)

	if err := requireTestInstance(ctx, pool); err != nil {
		t.Fatalf("refusing to run: %v", err)
	}

	// Each run starts from a clean slate.
	if _, err := pool.Exec(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`); err != nil {
		t.Fatalf("reset schema: %v", err)
	}
	if err := db.Migrate(ctx, pool); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	cfg := &config.Config{
		JWTSecret:         []byte("test-secret"),
		EncryptionKey:     sha256.Sum256([]byte("test-encryption-key")),
		SessionTTL:        time.Hour,
		RelayTimeout:      30 * time.Second,
		StreamIdleTimeout: 10 * time.Second,
		MaxRetries:        3,
		AllowRegister:     true,
		InitQuota:         billing.ParseUSD(1),
		// A real console directory, because "no web dir" takes a different
		// branch in the SPA handler and would hide how unrouted /api paths
		// behave in an actual deployment.
		WebDir:         webDirForTest(t),
		UnpricedPolicy: string(billing.PolicyReject),
		// Deliberately not the production claim: serving that here would pass
		// even if the handler ignored configuration and echoed a constant.
		ARAClaim: testARAClaim,
	}

	cipher, err := auth.NewCipher(cfg.EncryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	st := store.New(pool, cipher)

	if err := billing.SeedDefaults(ctx, st); err != nil {
		t.Fatal(err)
	}
	pricer := billing.NewPricer(st, billing.Settings{
		UnpricedPolicy: billing.UnpricedPolicy(cfg.UnpricedPolicy),
	})
	if err := pricer.Reload(ctx); err != nil {
		t.Fatal(err)
	}

	adminHash, _ := auth.HashPassword("admin-password")
	if _, err := st.CreateUser(ctx, &model.User{
		Username: "admin", PasswordHash: adminHash, Role: model.RoleAdmin,
		Status: model.StatusEnabled, Group: "default", Quota: billing.ParseUSD(100),
	}); err != nil {
		t.Fatal(err)
	}

	jwt := auth.NewJWTManager(cfg.JWTSecret, cfg.SessionTTL)
	srv := httptest.NewServer(NewServer(cfg, st, jwt, pricer, relay.New(st, pricer, cfg)).Handler())
	t.Cleanup(srv.Close)

	h := &harness{t: t, server: srv, store: st, pool: pool}
	h.admin = h.login("admin", "admin-password")
	return h
}

// webDirForTest builds a minimal console directory so the SPA fallback runs the
// same branch it does in production.
func webDirForTest(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"),
		[]byte("<!doctype html><title>test console</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "assets", "app-abc123.js"),
		[]byte("console.log(1)"), 0o600); err != nil {
		t.Fatal(err)
	}
	return dir
}

// The billing endpoints exist so another gateway can read the credit behind a
// key. The strongest check available is to point this gateway's own balance
// probe at itself: that probe is a new-api client, so parsing its own output
// is what compatibility means here.
func TestBillingEndpointsAreReadableByTheBalanceProbe(t *testing.T) {
	h := newHarness(t)

	// $10 of balance, with a key limited to $4 of it.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "holder", "password": "password123", "quota_usd": 10,
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "holder", Password: "password123"}, &session)

	var created struct {
		Key string `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", session.Token, tokenInput{
		Name: "limited", UnlimitedQuota: false, QuotaUSD: 4,
	}, &created)
	resp.Body.Close()

	// A channel pointing back at this very server, authenticated with that key.
	id := h.createChannel(channelInput{
		Name: "self", Type: "openai", BaseURL: h.server.URL, APIKey: created.Key,
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var balance relay.Balance
	resp = h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/balance", id),
		h.admin, nil, &balance)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("balance: HTTP %d", resp.StatusCode)
	}
	if !balance.OK {
		t.Fatalf("the probe could not read our own billing endpoints: %+v", balance)
	}
	if balance.Provider != "new-api" {
		t.Fatalf("recognised as %q, want the new-api dialect", balance.Provider)
	}
	// The key allows $4 and the account holds $10, so $4 is what it can spend.
	if balance.Remaining == nil || *balance.Remaining != 4 {
		t.Fatalf("remaining = %v, want 4", balance.Remaining)
	}
}

func TestSub2APIBalanceUsesItsDedicatedEndpoint(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sub2-key" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"quota":    map[string]any{"remaining": "7.5", "total": 10, "unit": "USD"},
			"usage":    map[string]any{"total": map[string]any{"actual_cost": "2.5"}},
			"planName": "Pro",
		})
	})
	id := h.createChannel(channelInput{
		Name: "sub2api", BaseURL: up.URL, APIKey: "sub2-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var balance relay.Balance
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/balance/sub2api", id), h.admin, nil, &balance)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !balance.OK {
		t.Fatalf("HTTP %d, balance %+v", resp.StatusCode, balance)
	}
	if balance.Provider != "sub2api" || balance.PlanName != "Pro" {
		t.Fatalf("unexpected identity: %+v", balance)
	}
	if balance.Remaining == nil || *balance.Remaining != 7.5 ||
		balance.Used == nil || *balance.Used != 2.5 ||
		balance.Total == nil || *balance.Total != 10 {
		t.Fatalf("unexpected amounts: %+v", balance)
	}
}

// The two amounts use different units — dollars in one call, cents in the
// other — and getting that backwards is invisible until a caller reports a
// balance a hundred times too large.
func TestBillingUsageIsReportedInCents(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1000, 1000)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	// Priced explicitly so the arithmetic below is not at the mercy of the
	// bundled catalogue: 1 micro-USD per token each way.
	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "gpt-4o", InputPrice: 1, OutputPrice: 1}, nil)

	key := h.createKey()
	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	h.waitForLog(t, 1)

	req, err := http.NewRequest(http.MethodGet,
		h.server.URL+"/dashboard/billing/usage?start_date=2020-01-01&end_date=2099-12-31", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var usage struct {
		Object     string  `json:"object"`
		TotalUsage float64 `json:"total_usage"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&usage)
	resp.Body.Close()

	// 1000 prompt + 1000 completion at $1 per million each is $0.002, so 0.2
	// cents. Anything reported in dollars here would come back as 0.002.
	if usage.TotalUsage < 0.19 || usage.TotalUsage > 0.21 {
		t.Fatalf("total_usage = %v cents, want ~0.2", usage.TotalUsage)
	}
}

// Without a key these say nothing: they report how much credit exists, which
// is not something an anonymous caller gets to ask.
func TestBillingEndpointsNeedAKey(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{
		"/dashboard/billing/subscription",
		"/dashboard/billing/usage",
	} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s without a key: HTTP %d, want 401", path, resp.StatusCode)
		}
	}
}

// One box, everything an operator might remember about a channel — except the
// one field that holds secrets.
func TestChannelSearchSpansEveryDescriptiveField(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "north-gateway", Type: "anthropic", BaseURL: "https://relay.example.test",
		AuthStyle: model.AuthStyleXAPIKey,
		APIKey:    "sk-upstream-secret",
		Models:    []string{"claude-opus-5"}, ModelPrefixes: []string{"gemini-"},
		Groups: []string{"vip"}, TestModel: "claude-haiku",
		ModelMapping: map[string]string{"gpt-4o": "claude-sonnet-4"},
		Note:         "备用线路",
	})
	// A second channel that must not match any of the searches below.
	h.createChannel(channelInput{
		Name: "south", Type: "openai", BaseURL: "https://other.test", APIKey: "k",
		Models: []string{"gpt-3.5"}, Groups: []string{"default"},
	})

	for _, tc := range []struct{ name, keyword string }{
		{"name", "north"},
		{"base url", "relay.example"},
		{"auth style", "x-api-key"},
		{"note", "备用"},
		{"test model", "haiku"},
		{"served model", "opus"},
		{"model prefix", "gemini-"},
		{"group", "vip"},
		{"mapping source", "gpt-4o"},
		{"mapping target", "claude-sonnet"},
		{"case insensitive", "NORTH-GATEWAY"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var listed page[*model.Channel]
			resp := h.do(http.MethodGet,
				"/api/admin/channels?keyword="+url.QueryEscape(tc.keyword), h.admin, nil, &listed)
			resp.Body.Close()
			if len(listed.Data) != 1 || listed.Data[0].Name != "north-gateway" {
				t.Fatalf("searching %q matched %d channels", tc.keyword, len(listed.Data))
			}
		})
	}

	// The upstream credential is not searchable: a field that can be probed a
	// character at a time can be read a character at a time.
	var listed page[*model.Channel]
	resp := h.do(http.MethodGet, "/api/admin/channels?keyword=sk-upstream", h.admin, nil, &listed)
	resp.Body.Close()
	if len(listed.Data) != 0 {
		t.Fatalf("the upstream key is searchable: %d matches", len(listed.Data))
	}

	// And a literal wildcard stays literal.
	resp = h.do(http.MethodGet, "/api/admin/channels?keyword="+url.QueryEscape("%"),
		h.admin, nil, &listed)
	resp.Body.Close()
	if len(listed.Data) != 0 {
		t.Fatalf("%% behaved as a wildcard and matched %d channels", len(listed.Data))
	}
}

// ------------------------------------------------------------------ keepalive

// channel returns the channel as the API reports it, for reading the window
// state back after the relay's detached bookkeeping has run.
func (h *harness) channel(id int64) model.Channel {
	h.t.Helper()
	var fetched model.Channel
	resp := h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, nil, &fetched)
	resp.Body.Close()
	return fetched
}

// The point of the feature: an upstream that reclaims an idle account gets a
// few real requests a day and is then taken back out of rotation. The count is
// asserted after every single request, not just at the end — a channel that
// closes one request early or late is a different feature.
func TestKeepaliveClosesTheChannelExactlyAtItsTarget(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "keepalive", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 3,
	})
	// A keepalive channel is configured while disabled; the scheduler is what
	// opens it. Opening it directly keeps the test off the wall clock.
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if ch := h.channel(id); ch.Status != model.StatusEnabled || !ch.KeepaliveOpen ||
		ch.KeepaliveSuccess != 0 {
		t.Fatalf("after opening: status %d, open %v, success %d",
			ch.Status, ch.KeepaliveOpen, ch.KeepaliveSuccess)
	}

	key := h.createKey()
	body := `{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`

	for want := int32(1); want <= 3; want++ {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("request %d: HTTP %d", want, resp.StatusCode)
		}
		waitFor(t, func() bool { return h.channel(id).KeepaliveSuccess >= want },
			waiting(fmt.Sprintf("keepalive success to reach %d", want)))

		ch := h.channel(id)
		if ch.KeepaliveSuccess != want {
			t.Fatalf("after %d successful requests the counter is %d", want, ch.KeepaliveSuccess)
		}
		// Still open below the target, closed on reaching it.
		wantStatus, wantOpen := int16(model.StatusEnabled), true
		if want == 3 {
			wantStatus, wantOpen = model.StatusDisabled, false
		}
		if ch.Status != wantStatus || ch.KeepaliveOpen != wantOpen {
			t.Fatalf("after %d/3 requests: status %d (want %d), open %v (want %v)",
				want, ch.Status, wantStatus, ch.KeepaliveOpen, wantOpen)
		}
	}

	// Closed means out of rotation for real: selection reads the routing tables,
	// not channels.status, so a channel disabled without syncing them would keep
	// serving traffic while the console showed it as off.
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		t.Fatal("a closed keepalive channel still served a request")
	}

	// The window stamp survives closing: it is what stops the scheduler
	// reopening the channel for the same day.
	if h.channel(id).KeepaliveOpenedAt == nil {
		t.Fatal("keepalive_opened_at was cleared on close")
	}
}

// Only successes count. An upstream erroring its way through the window would
// otherwise satisfy a keepalive that never actually kept anything alive.
func TestKeepaliveIgnoresFailedRequests(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"nope"}}`))
	})
	id := h.createChannel(channelInput{
		Name: "keepalive-failing", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1,
	})
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	// 400 is passed straight through rather than retried, so the attempt is
	// certainly recorded by the time the error count moves.
	waitFor(t, func() bool { return h.channel(id).ErrorCount > 0 },
		waiting("the failed attempt to be recorded"))

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 0 {
		t.Fatalf("a failed request advanced the keepalive counter to %d", ch.KeepaliveSuccess)
	}
	if ch.Status != model.StatusEnabled || !ch.KeepaliveOpen {
		t.Fatalf("the window closed on a failure: status %d, open %v", ch.Status, ch.KeepaliveOpen)
	}
}

// Turning the channel off by hand abandons the window. Otherwise the counter
// would keep standing against a channel that serves nothing, and the operator's
// decision would be undone by the next success that trickled in.
func TestKeepaliveWindowIsAbandonedWhenDisabledByHand(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-manual", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()

	for _, tc := range []struct {
		name string
		// Takes the subtest's own t: these closures are built before t.Run, so
		// a captured t would be the parent, and failing a parent from inside a
		// subtest is not allowed.
		disable func(t *testing.T)
	}{
		{
			name: "the listing toggle",
			disable: func(t *testing.T) {
				resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id),
					h.admin, map[string]any{"status": model.StatusDisabled}, nil)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("disable via the status endpoint: HTTP %d", resp.StatusCode)
				}
			},
		},
		{
			// The edit form submits status alongside everything else, so it is a
			// second, easily missed way to disable a channel.
			name: "saving the edit form as disabled",
			disable: func(t *testing.T) {
				resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
					channelInput{
						Name: "keepalive-manual", BaseURL: "https://unused.test",
						Models: []string{"gpt-4o"}, Groups: []string{"default"},
						Status:           model.StatusDisabled,
						KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
					}, nil)
				resp.Body.Close()
				if resp.StatusCode != http.StatusOK {
					t.Fatalf("disable via the edit form: HTTP %d", resp.StatusCode)
				}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
				t.Fatal(err)
			}
			if ch := h.channel(id); !ch.KeepaliveOpen {
				t.Fatal("the window did not open")
			}

			tc.disable(t)

			ch := h.channel(id)
			if ch.Status != model.StatusDisabled {
				t.Fatalf("status = %d, want disabled", ch.Status)
			}
			if ch.KeepaliveOpen {
				t.Fatal("the keepalive window survived a manual disable")
			}
			// Kept, so the scheduler treats today's window as already run.
			if ch.KeepaliveOpenedAt == nil {
				t.Fatal("keepalive_opened_at was cleared")
			}
		})
	}
}

// The configuration is refused rather than accepted and silently ignored: a
// channel that claims to be kept alive and never opens is worse than an error.
func TestKeepaliveConfigurationIsValidated(t *testing.T) {
	h := newHarness(t)

	for _, tc := range []struct {
		name string
		in   channelInput
		want int
	}{
		{
			name: "no time",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "unparseable time",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "3pm", KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "hour out of range",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "25:00", KeepaliveTarget: 3},
			want: http.StatusBadRequest,
		},
		{
			name: "zero target",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 0},
			want: http.StatusBadRequest,
		},
		{
			name: "valid",
			in:   channelInput{KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1},
			want: http.StatusCreated,
		},
		{
			// The schedule fields are only read when keepalive is on, so junk
			// left behind by an operator switching it off must not block a save.
			name: "off, so the schedule is not checked",
			in:   channelInput{KeepaliveEnabled: false, KeepaliveAt: "", KeepaliveTarget: 0},
			want: http.StatusCreated,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := tc.in
			in.Name = "keepalive-" + strings.ReplaceAll(tc.name, " ", "-")
			in.BaseURL = "https://unused.test"
			in.APIKey = "k"
			in.Models = []string{"gpt-4o"}
			resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, in, nil)
			resp.Body.Close()
			if resp.StatusCode != tc.want {
				t.Fatalf("HTTP %d, want %d", resp.StatusCode, tc.want)
			}
		})
	}
}

// Saving the form must not disturb a window that is counting: the operator
// edited a note, not the keepalive progress.
func TestKeepaliveProgressSurvivesAnEdit(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-edit", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()
	if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
		t.Fatal(err)
	}
	// Two successes into the window.
	h.store.RecordChannelResult(ctx, id, 0, "")
	h.store.RecordChannelResult(ctx, id, 0, "")
	if got := h.channel(id).KeepaliveSuccess; got != 2 {
		t.Fatalf("keepalive success = %d, want 2", got)
	}

	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
		channelInput{
			Name: "keepalive-edit", BaseURL: "https://unused.test",
			Models: []string{"gpt-4o"}, Groups: []string{"default"},
			Status: model.StatusEnabled, Note: "edited",
			KeepaliveEnabled: true, KeepaliveAt: "04:30", KeepaliveTarget: 5,
		}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("edit: HTTP %d", resp.StatusCode)
	}

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 2 || !ch.KeepaliveOpen {
		t.Fatalf("the edit reset the window: success %d, open %v",
			ch.KeepaliveSuccess, ch.KeepaliveOpen)
	}
	if ch.KeepaliveAt != "04:30" {
		t.Fatalf("keepalive_at = %q, want 04:30", ch.KeepaliveAt)
	}
}

// A clone points at the same upstream and starts disabled; it must not also
// inherit a window that is mid-count.
func TestKeepaliveCloneStartsWithNoWindow(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "keepalive-source", BaseURL: "https://unused.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 5,
	})
	ctx := context.Background()
	if err := h.store.OpenKeepaliveWindow(ctx, id); err != nil {
		t.Fatal(err)
	}
	h.store.RecordChannelResult(ctx, id, 0, "")

	var clone model.Channel
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin,
		map[string]string{"name": "keepalive-clone"}, &clone)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("clone: HTTP %d", resp.StatusCode)
	}

	// The configuration is worth inheriting; the running window is not.
	if !clone.KeepaliveEnabled || clone.KeepaliveAt != "03:00" || clone.KeepaliveTarget != 5 {
		t.Fatalf("the clone lost its keepalive configuration: %+v", clone)
	}
	if clone.KeepaliveOpen || clone.KeepaliveSuccess != 0 || clone.KeepaliveOpenedAt != nil {
		t.Fatalf("the clone inherited a running window: open %v, success %d, opened %v",
			clone.KeepaliveOpen, clone.KeepaliveSuccess, clone.KeepaliveOpenedAt)
	}
}

// The list is ordered the way traffic is: enabled channels first, then by
// priority, then by the weight that splits one priority band. A disabled
// channel sorted among the live ones by its old priority reads as part of the
// routing when it serves nothing.
func TestChannelListOrdersEnabledFirstThenPriorityThenWeight(t *testing.T) {
	h := newHarness(t)

	// Insertion order matches none of the sort keys, and the heavier of the two
	// priority-500 channels is created first on purpose: with a descending id
	// as the only tiebreaker the lighter one would come out on top, so the
	// weight step is what has to put the heavier one there.
	for _, c := range []struct {
		name     string
		status   int16
		priority int32
		weight   int32
	}{
		{"disabled-top-priority", model.StatusDisabled, 900, 50},
		{"enabled-high-priority-heavier", model.StatusEnabled, 500, 9},
		{"enabled-low-priority", model.StatusEnabled, 10, 99},
		{"enabled-high-priority", model.StatusEnabled, 500, 1},
		{"disabled-low-priority", model.StatusDisabled, 5, 1},
	} {
		h.createChannel(channelInput{
			Name: c.name, BaseURL: "https://" + c.name + ".test", APIKey: "k",
			Status: c.status, Priority: c.priority, Weight: c.weight,
			Models: []string{"gpt-4o"},
		})
	}

	var listed page[*model.Channel]
	resp := h.do(http.MethodGet, "/api/admin/channels", h.admin, nil, &listed)
	resp.Body.Close()

	want := []string{
		"enabled-high-priority-heavier", // priority 500, weight 9, lower id
		"enabled-high-priority",         // priority 500, weight 1
		"enabled-low-priority",          // priority 10 — weight 99 does not lift it
		"disabled-top-priority",         // disabled, despite priority 900
		"disabled-low-priority",
	}
	got := make([]string, 0, len(listed.Data))
	for _, c := range listed.Data {
		got = append(got, c.Name)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("channel order\n got %v\nwant %v", got, want)
	}
}

// The console masks the upstream key everywhere it is listed, so moving a
// channel elsewhere used to mean reading it out of the database. This endpoint
// exists to hand it over deliberately — and only to an administrator.
func TestChannelCredentialIsRevealedToAdminsOnly(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "movable", Type: "openai", BaseURL: "https://upstream.test/v1",
		APIKey: "sk-the-real-upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var cred struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	}
	resp := h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		h.admin, nil, &cred)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("credential: HTTP %d, want 200", resp.StatusCode)
	}
	if cred.APIKey != "sk-the-real-upstream-key" {
		t.Fatalf("returned %q, want the key in the clear", cred.APIKey)
	}
	if cred.BaseURL != "https://upstream.test/v1" {
		t.Fatalf("returned base url %q", cred.BaseURL)
	}

	// The listing must still hide it, or this endpoint would be pointless.
	var listed page[*model.Channel]
	resp = h.do(http.MethodGet, "/api/admin/channels", h.admin, nil, &listed)
	resp.Body.Close()
	if listed.Data[0].APIKey == "sk-the-real-upstream-key" {
		t.Fatal("the listing exposed the upstream key")
	}

	// A regular account has no business reading an upstream credential.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "peon3", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "peon3", Password: "password123"}, &session)

	resp = h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		session.Token, nil, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user read the credential: HTTP %d", resp.StatusCode)
	}
	if strings.Contains(string(body), "sk-the-real-upstream-key") {
		t.Fatalf("the key leaked in the refusal: %s", body)
	}
}

func TestChannelRequiresABaseURL(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, channelInput{
		Name: "default-host", Type: "anthropic", APIKey: "k",
		Models: []string{"claude-3"}, Groups: []string{"default"},
	}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestChannelTypeIsCompatibilityInputOnly(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, map[string]any{
		"name": "type-free", "type": "anthropic", "base_url": "https://upstream.test",
		"api_key": "k", "models": []string{"gpt-4o"}, "groups": []string{"default"},
	}, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	var created map[string]json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if _, exists := created["type"]; exists {
		t.Fatalf("channel response still contains type: %v", created)
	}
	var authStyle string
	if err := json.Unmarshal(created["auth_style"], &authStyle); err != nil {
		t.Fatal(err)
	}
	if authStyle != model.AuthStyleAuto {
		t.Fatalf("auth_style = %q, want auto", authStyle)
	}

	var hasType, hasAuthStyle bool
	err := h.pool.QueryRow(context.Background(), `SELECT
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'type'),
		EXISTS (SELECT 1 FROM information_schema.columns
			WHERE table_schema = 'public' AND table_name = 'channels' AND column_name = 'auth_style')`).
		Scan(&hasType, &hasAuthStyle)
	if err != nil {
		t.Fatal(err)
	}
	if hasType || !hasAuthStyle {
		t.Fatalf("schema columns: type=%v auth_style=%v", hasType, hasAuthStyle)
	}
}

// A probe reaches an upstream and spends real money, so it belongs in the log
// like anything else — but marked, so reports can tell it from client traffic.
func TestChannelTestIsLogged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "pong", 11, 3)
	})
	id := h.createChannel(channelInput{
		Name: "probed", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o", "prompt": "say pong"}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !result.OK {
		t.Fatalf("probe: HTTP %d, result %+v", resp.StatusCode, result)
	}

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the probe to be logged"))

	entry := listed.Data[0]
	switch {
	case entry.ChannelID != id:
		t.Fatalf("logged against channel %d, want %d", entry.ChannelID, id)
	case entry.Model != "gpt-4o":
		t.Fatalf("logged model %q", entry.Model)
	case entry.Username != "admin":
		t.Fatalf("logged user %q, want the administrator who ran it", entry.Username)
	case entry.StatusCode != http.StatusOK:
		t.Fatalf("logged status %d", entry.StatusCode)
	case entry.TotalTokens == 0:
		t.Fatal("the probe's token usage was not recorded")
	}
	// Filterable, so a report can exclude console probes from real traffic.
	if entry.ClientType != ChannelTestClient || entry.TokenName != ChannelTestClient {
		t.Fatalf("the probe is not marked: client=%q token=%q",
			entry.ClientType, entry.TokenName)
	}

	// The marker has to be reachable from the search box too.
	var found page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/admin/logs?keyword="+ChannelTestClient, h.admin, nil, &found)
	r.Body.Close()
	if len(found.Data) != 1 {
		t.Fatalf("searching for the marker found %d rows", len(found.Data))
	}

	// The exchange is the most useful part of a probe: what was asked, and
	// exactly how the upstream answered.
	var detail model.RequestLogDetail
	r = h.do(http.MethodGet, fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID),
		h.admin, nil, &detail)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("probe detail: HTTP %d, want 200", r.StatusCode)
	}
	if !strings.Contains(detail.RequestBody, "say pong") {
		t.Fatalf("the probe's request was not stored: %s", detail.RequestBody)
	}
	if !strings.Contains(detail.ResponseBody, "pong") {
		t.Fatalf("the upstream's reply was not stored: %s", detail.ResponseBody)
	}
	// The channel's own credential travels on a probe; storing it verbatim
	// would put an upstream key in the log.
	if raw, _ := json.Marshal(detail.RequestHeaders); strings.Contains(string(raw), "\"k\"") {
		t.Fatalf("the upstream credential was stored: %s", raw)
	}
}

// An upstream that never answers still produced a probe, and that attempt is
// the thing worth seeing in the log.
func TestFailedChannelTestIsLogged(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "unreachable", Type: "openai",
		// Refused immediately rather than timing out, so the test stays fast.
		BaseURL: "http://127.0.0.1:1", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o"}, nil)
	resp.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the failed probe to be logged"))

	entry := listed.Data[0]
	// A probe that never reached the upstream has no status of its own; it
	// must not be filed as a success.
	if entry.StatusCode < 400 {
		t.Fatalf("a failed probe was logged as HTTP %d", entry.StatusCode)
	}
	if entry.Error == "" {
		t.Fatal("the failure reason was not recorded")
	}
	if entry.Cost != 0 {
		t.Fatalf("a failed probe was billed %d", entry.Cost)
	}
}

// The search box exists for when the operator knows something about a call but
// not which field it was, so it has to reach across columns — and the live feed
// has to agree with the list about what matches.
func TestLogKeywordSearchSpansColumns(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "searchable-channel", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the call to be logged"))

	// Each of these lives in a different column.
	for _, tc := range []struct{ name, keyword string }{
		{"channel name", "searchable"},
		{"model", "gpt-4"},
		{"username", "admin"},
		{"endpoint", "chat/completions"},
		{"key name", "test"},
		{"case insensitive", "SEARCHABLE-CHANNEL"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var found page[*model.RequestLog]
			r := h.do(http.MethodGet, "/api/admin/logs?keyword="+url.QueryEscape(tc.keyword),
				h.admin, nil, &found)
			r.Body.Close()
			if len(found.Data) == 0 {
				t.Fatalf("searching %q found nothing", tc.keyword)
			}
		})
	}

	// The id is shown on every row precisely so it can be quoted back; a
	// search that ignored it would make the column decorative.
	target := listed.Data[0]
	var byID page[*model.RequestLog]
	r := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs?keyword=%d", target.ID), h.admin, nil, &byID)
	r.Body.Close()
	if len(byID.Data) != 1 || byID.Data[0].ID != target.ID {
		t.Fatalf("searching for id %d returned %d rows", target.ID, len(byID.Data))
	}

	var empty page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/admin/logs?keyword=definitely-not-present",
		h.admin, nil, &empty)
	r.Body.Close()
	if len(empty.Data) != 0 {
		t.Fatalf("an unrelated keyword matched %d rows", len(empty.Data))
	}

	// A value containing SQL wildcards must be taken literally, not as a
	// pattern that matches everything.
	r = h.do(http.MethodGet, "/api/admin/logs?keyword="+url.QueryEscape("%"), h.admin, nil, &empty)
	r.Body.Close()
	if len(empty.Data) != 0 {
		t.Fatalf("%% was treated as a wildcard and matched %d rows", len(empty.Data))
	}
}

// A live entry must be appended exactly when a reload would have listed it;
// otherwise the feed contradicts the search that is on screen.
func TestLogStreamHonoursTheKeyword(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "streamy", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	matching, closeMatching := h.openStream(t, "/api/admin/logs/stream?keyword=streamy", h.admin)
	defer closeMatching()
	other, closeOther := h.openStream(t, "/api/admin/logs/stream?keyword=nothing-like-this", h.admin)
	defer closeOther()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	select {
	case entry := <-matching:
		if entry == nil || entry.ChannelName != "streamy" {
			t.Fatalf("unexpected entry: %+v", entry)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("a matching entry never arrived")
	}

	select {
	case entry := <-other:
		t.Fatalf("an entry that does not match the search was pushed: %+v", entry)
	case <-time.After(time.Second):
		// Correct: the feed agrees with the search.
	}
}

// A cached index.html pins a browser to whichever build it named, so every
// later deploy is invisible until someone force-reloads. The hashed bundles
// have the opposite requirement: their names change, so they can be kept
// forever.
func TestConsoleCachingLetsANewBuildThrough(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/", "/index.html", "/admin/settings"} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s served with Cache-Control %q, want no-cache", path, got)
		}
	}

	resp, err := http.Get(h.server.URL + "/assets/app-abc123.js")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !strings.Contains(resp.Header.Get("Cache-Control"), "immutable") {
		t.Fatalf("hashed asset served with Cache-Control %q, want immutable",
			resp.Header.Get("Cache-Control"))
	}
}

// testARAClaim stands in for the deployment claim so the assertions below
// prove the route reads configuration. config_test.go pins the real default.
const testARAClaim = "ara-site-verification=harness-claim"

// The ARA registry proves domain ownership by fetching a file over the domain,
// and the SPA fallback answers anything it cannot find on disk with index.html
// — a 200 full of HTML, which reads as "served" to a smoke test and as a failed
// claim to the verifier. This pins the route to real text.
func TestARAClaimIsServedAsAPlainTextFile(t *testing.T) {
	h := newHarness(t)

	resp, err := http.Get(h.server.URL + "/.well-known/ara-claim.txt")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("claim answered %d, want 200", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("claim served as %q, want text/plain", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(body)) != testARAClaim {
		t.Fatalf("claim body %q, want %q", body, testARAClaim)
	}
}

// An unconfigured claim must not answer 200 with an empty body: the verifier
// would read that as the domain serving the wrong claim rather than as a
// deployment that simply has none.
func TestARAClaimWithoutAConfiguredValueIs404(t *testing.T) {
	srv := &Server{cfg: &config.Config{}}

	rec := httptest.NewRecorder()
	srv.handleARAClaim(rec, httptest.NewRequest(http.MethodGet, "/.well-known/ara-claim.txt", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("unconfigured claim answered %d, want 404", rec.Code)
	}
}

// do issues an API call and decodes the JSON response.
func (h *harness) do(method, path, token string, body any, out any) *http.Response {
	h.t.Helper()

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			h.t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, h.server.URL+path, reader)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}

	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	if out != nil {
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if err := json.Unmarshal(raw, out); err != nil {
			h.t.Fatalf("%s %s -> %d: cannot decode %s", method, path, resp.StatusCode, raw)
		}
	}
	return resp
}

func (h *harness) login(username, password string) string {
	h.t.Helper()
	var session sessionResponse
	resp := h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: username, Password: password}, &session)
	if resp.StatusCode != http.StatusOK {
		h.t.Fatalf("login failed: HTTP %d", resp.StatusCode)
	}
	return session.Token
}

// createChannel registers an upstream and returns its id.
func (h *harness) createChannel(in channelInput) int64 {
	h.t.Helper()
	var created model.Channel
	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, in, &created)
	if resp.StatusCode != http.StatusCreated {
		h.t.Fatalf("create channel: HTTP %d", resp.StatusCode)
	}
	return created.ID
}

// settings reads the current console settings. Updates replace the whole
// object, so a caller changing one field starts from this rather than from a
// zero value that would fail validation on every other field.
func (h *harness) settings(t *testing.T) consoleSettings {
	t.Helper()
	var current consoleSettings
	resp := h.do(http.MethodGet, "/api/settings", h.admin, nil, &current)
	resp.Body.Close()
	return current
}

// waitFor polls until cond holds. The relay writes its logs from a detached
// goroutine, so anything checking what was persisted has to wait for it rather
// than assume it has landed.
//
// describe is a function so the message reports the state at the moment of
// failure; building the string up front would capture it before the first poll
// and report the zero value on every timeout.
func waitFor(t *testing.T, cond func() bool, describe func() string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", describe())
}

// waiting builds a static description for waitFor.
func waiting(text string) func() string {
	return func() string { return text }
}

// createKey mints a relay API key for the admin user.
func (h *harness) createKey() string {
	h.t.Helper()
	var out struct {
		Key string `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", h.admin,
		tokenInput{Name: "test", UnlimitedQuota: true}, &out)
	if resp.StatusCode != http.StatusCreated {
		h.t.Fatalf("create token: HTTP %d", resp.StatusCode)
	}
	return out.Key
}

// relayRequest calls the proxy surface with a relay key.
func (h *harness) relayRequest(method, path, key, body string) *http.Response {
	h.t.Helper()
	req, err := http.NewRequest(method, h.server.URL+path, strings.NewReader(body))
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	return resp
}

// ------------------------------------------------------------- mock upstream

type upstream struct {
	*httptest.Server
	requests atomic.Int64
	lastBody atomic.Value // string
	lastPath atomic.Value // string
	lastAuth atomic.Value // string
	lastHdrs atomic.Value // http.Header
}

func newUpstream(t *testing.T, handler func(u *upstream, w http.ResponseWriter, r *http.Request)) *upstream {
	u := &upstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.requests.Add(1)
		body, _ := io.ReadAll(r.Body)
		u.lastBody.Store(string(body))
		u.lastPath.Store(r.URL.RequestURI())
		u.lastAuth.Store(r.Header.Get("Authorization"))
		u.lastHdrs.Store(r.Header.Clone())
		handler(u, w, r)
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *upstream) body() string { s, _ := u.lastBody.Load().(string); return s }
func (u *upstream) path() string { s, _ := u.lastPath.Load().(string); return s }
func (u *upstream) auth() string { s, _ := u.lastAuth.Load().(string); return s }
func (u *upstream) headers() http.Header {
	h, _ := u.lastHdrs.Load().(http.Header)
	return h
}

// chatResponse is a canned OpenAI-shaped answer with usage.
func chatResponse(w http.ResponseWriter, content string, prompt, completion int) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      "chatcmpl-test",
		"object":  "chat.completion",
		"choices": []map[string]any{{"index": 0, "message": map[string]string{"role": "assistant", "content": content}}},
		"usage": map[string]int{
			"prompt_tokens": prompt, "completion_tokens": completion,
			"total_tokens": prompt + completion,
		},
	})
}

// -------------------------------------------------------------------- tests

func TestRelayPassesRequestThroughVerbatim(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "pong", 10, 4)
	})

	h.createChannel(channelInput{
		Name: "primary", Type: "openai", BaseURL: up.URL, APIKey: "upstream-secret",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Weight: 1,
	})

	key := h.createKey()
	reqBody := `{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}],"temperature":0.42,"custom_vendor_field":{"a":[1,2,3]}}`
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, reqBody)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	// The body must arrive byte-for-byte: unknown vendor fields included.
	if up.body() != reqBody {
		t.Errorf("body was modified:\n got: %s\nwant: %s", up.body(), reqBody)
	}
	// The caller's key must be replaced by the channel credential.
	if up.auth() != "Bearer upstream-secret" {
		t.Errorf("upstream saw Authorization %q", up.auth())
	}
	if up.path() != "/v1/chat/completions" {
		t.Errorf("upstream path = %q", up.path())
	}

	var answer struct {
		Choices []struct {
			Message struct{ Content string } `json:"message"`
		} `json:"choices"`
	}
	raw, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(raw, &answer); err != nil {
		t.Fatalf("bad response: %s", raw)
	}
	if len(answer.Choices) != 1 || answer.Choices[0].Message.Content != "pong" {
		t.Fatalf("unexpected response: %s", raw)
	}
}

func TestRelayForwardsClientHeadersButStripsCredentials(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "sk-upstream",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, _ := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o"}`))
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Custom-Trace", "trace-123")
	req.Header.Set("OpenAI-Beta", "assistants=v2")
	req.Header.Set("Cookie", "session=leak-me")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	hdrs := up.headers()
	if got := hdrs.Get("X-Custom-Trace"); got != "trace-123" {
		t.Errorf("custom header lost: %q", got)
	}
	if got := hdrs.Get("OpenAI-Beta"); got != "assistants=v2" {
		t.Errorf("vendor header lost: %q", got)
	}
	if got := hdrs.Get("Cookie"); got != "" {
		t.Errorf("client cookie leaked upstream: %q", got)
	}
}

func TestChannelUserAgentLocksPerProtocolAndCanClear(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "ua-lock", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, LockUserAgent: true,
	})
	key := h.createKey()

	send := func(path, ua string, wantStatus int) {
		req, err := http.NewRequest(http.MethodPost, h.server.URL+path,
			strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("User-Agent", ua)
		resp, err := h.server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != wantStatus {
			t.Fatalf("%s with UA %q: HTTP %d, want %d", path, ua, resp.StatusCode, wantStatus)
		}
	}

	send("/v1/chat/completions", "chat-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "chat-first" {
		t.Fatalf("first chat User-Agent = %q", got)
	}
	channel, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got := channel.LockedUserAgents[model.ProtocolChatCompletions]; got != "chat-first" {
		t.Fatalf("successful chat request did not auto-lock UA: %q", got)
	}
	send("/v1/chat/completions", "chat-second", http.StatusOK)
	if got := up.requests.Load(); got != 2 {
		t.Fatalf("second request count=%d, want 2", got)
	}
	if got := up.headers().Get("User-Agent"); got != "chat-first" {
		t.Fatalf("locked chat User-Agent = %q, want chat-first", got)
	}

	send("/v1/messages", "messages-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "messages-first" {
		t.Fatalf("messages User-Agent = %q, want messages-first", got)
	}
	send("/v1/responses", "responses-first", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "responses-first" {
		t.Fatalf("responses User-Agent = %q, want responses-first", got)
	}

	clearURL := fmt.Sprintf("/api/admin/channels/%d/user-agent/clear?protocol=chat_completions", id)
	resp := h.do(http.MethodPost, clearURL, h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("clear chat User-Agent: HTTP %d", resp.StatusCode)
	}
	send("/v1/chat/completions", "chat-third", http.StatusOK)
	if got := up.headers().Get("User-Agent"); got != "chat-third" {
		t.Fatalf("relocked chat User-Agent = %q, want chat-third", got)
	}
}

func TestChannelUserAgentManualConfigOverridesHeadersWithoutAutoLocking(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "ua-manual", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers:          map[string]string{"User-Agent": "header-ua"},
		LockedUserAgents: map[string]string{model.ProtocolChatCompletions: "manual-ua"},
	})
	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("manual UA request: HTTP %d", resp.StatusCode)
	}
	if got := up.headers().Get("User-Agent"); got != "manual-ua" {
		t.Fatalf("upstream User-Agent = %q, want manual-ua", got)
	}
	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.LockUserAgent {
		t.Fatal("manual UA unexpectedly enabled automatic locking")
	}
	if got := ch.LockedUserAgents[model.ProtocolChatCompletions]; got != "manual-ua" {
		t.Fatalf("manual UA was not retained: %q", got)
	}
}

func TestChannelUserAgentAutoLockHappensOnlyAfterSuccess(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusBadRequest)
	})
	id := h.createChannel(channelInput{
		Name: "ua-auto-failure", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, LockUserAgent: true,
	})
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(),
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("failed auto-lock request: HTTP %d", resp.StatusCode)
	}
	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if got := ch.LockedUserAgents[model.ProtocolChatCompletions]; got != "" {
		t.Fatalf("failed request auto-locked UA %q", got)
	}
}

func TestChannelCanRejectConversationAttachmentsBeforeUpstream(t *testing.T) {
	h := newHarness(t)
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "should not be reached", 1, 1)
	})
	allow := false
	h.createChannel(channelInput{
		Name: "text-only", Type: "openai", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, AllowAttachments: &allow,
	})
	key := h.createKey()
	body := `{"model":"gpt-4o","messages":[{"role":"user","content":[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="}}]}]}`
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, body)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("attachment request: HTTP %d, want 429: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "attachments_not_allowed") {
		t.Fatalf("unexpected attachment rejection: %s", raw)
	}
	if !strings.Contains(string(raw), "请求不能携带附件") {
		t.Fatalf("attachment rejection message is unclear: %s", raw)
	}
	if strings.Contains(string(raw), "text-only") || strings.Contains(string(raw), "channel") {
		t.Fatalf("attachment rejection leaked channel information: %s", raw)
	}
	if got := up.requests.Load(); got != 0 {
		t.Fatalf("attachment rejection reached upstream %d time(s)", got)
	}

	plain := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"plain text"}]}`)
	plain.Body.Close()
	if plain.StatusCode != http.StatusOK {
		t.Fatalf("plain text request: HTTP %d, want 200", plain.StatusCode)
	}
}

func TestChannelHeadersOverrideGeneratedAuthentication(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "custom-auth", Type: "openai", BaseURL: up.URL, APIKey: "generated-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		Headers: map[string]string{"Authorization": "Token channel-override"},
	})

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", h.createKey(),
		`{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}
	if got := up.auth(); got != "Token channel-override" {
		t.Fatalf("Authorization = %q, want the channel override", got)
	}
}

func TestRelayStreamsSSEAndBillsUsage(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"he"}}]}`,
			`{"choices":[{"delta":{"content":"llo"}}]}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})

	h.createChannel(channelInput{
		Name: "stream", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"stream_options":{"include_usage":true}}`)
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "data: [DONE]") {
		t.Fatalf("stream was not relayed intact: %s", raw)
	}
	if !strings.Contains(string(raw), `"content":"llo"`) {
		t.Fatalf("stream content missing: %s", raw)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	// gpt-4o: $2.50/1M in, $10/1M out -> 1000*2.5 + 500*10 = 7500 micro-USD.
	entry := h.waitForLog(t, 1)
	if entry.PromptTokens != 1000 || entry.CompletionTokens != 500 {
		t.Fatalf("usage not captured from the stream: %+v", entry)
	}
	if entry.Cost != 7500 {
		t.Fatalf("cost = %d micro-USD, want 7500", entry.Cost)
	}
}

// A gateway under load answers 200 text/event-stream, pings a few times, then
// ends the stream with an error event. Scored on the status line that call looks
// perfect: no error text in the log, no failure against the channel, and the
// breaker keeps feeding an upstream that is refusing everything.
func TestRelayRecordsErrorsDeliveredInsideAStream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for range 2 {
			fmt.Fprint(w, "data: {\"type\":\"ping\"}\n\n")
			flusher.Flush()
		}
		fmt.Fprint(w, `data: {"error":{"message":"Concurrency limit exceeded for account, `+
			`please retry later","type":"rate_limit_error"},"type":"error"}`+"\n\n")
		flusher.Flush()
	})

	id := h.createChannel(channelInput{
		Name: "stream-error", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
		`{"model":"claude-sonnet-4-5","stream":true,"max_tokens":16,`+
			`"messages":[{"role":"user","content":"hi"}]}`)
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	// The response still goes through untouched: the client asked for this
	// upstream's bytes and the headers were sent long before the error arrived.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the upstream's 200 relayed verbatim", resp.StatusCode)
	}
	if !strings.Contains(string(raw), "Concurrency limit exceeded") {
		t.Fatalf("the error event was not relayed to the caller: %s", raw)
	}

	entry := h.waitForLog(t, 1)
	if entry.StatusCode != http.StatusOK {
		t.Fatalf("logged status = %d, want the relayed 200", entry.StatusCode)
	}
	if !strings.Contains(entry.Error, "Concurrency limit exceeded") ||
		!strings.Contains(entry.Error, "rate_limit_error") {
		t.Fatalf("the in-stream failure was not logged: %q", entry.Error)
	}

	// Recorded against the channel, so the breaker benches it and the console
	// shows why. Without this the channel looks perfectly healthy.
	h.waitFor(t, "the in-stream failure to be recorded against the channel", func() bool {
		return h.channel(id).ErrorCount > 0
	})
	if last := h.channel(id).LastError; !strings.Contains(last, "Concurrency limit exceeded") {
		t.Fatalf("channel last_error = %q, want the upstream reason", last)
	}

	// The error filter is how an operator finds these at all.
	var listed struct {
		Data []*model.RequestLog `json:"data"`
	}
	if r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed); r.StatusCode != http.StatusOK {
		t.Fatalf("log list failed: %d", r.StatusCode)
	}
	if len(listed.Data) != 1 || listed.Data[0].ID != entry.ID {
		t.Fatalf("only_error did not surface the failed stream: %+v", listed.Data)
	}
}

// The same failure without SSE framing: a 200 whose JSON body is an error
// object. Same blind spot, same treatment.
func TestRelayRecordsErrorBodyBehindA200(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"error":{"code":429,"message":"Resource has been exhausted"}}`))
	})
	id := h.createChannel(channelInput{
		Name: "body-error", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want the upstream's 200 relayed verbatim", resp.StatusCode)
	}

	entry := h.waitForLog(t, 1)
	if !strings.Contains(entry.Error, "Resource has been exhausted") ||
		!strings.Contains(entry.Error, "429") {
		t.Fatalf("the error body behind the 200 was not logged: %q", entry.Error)
	}
	h.waitFor(t, "the failure to be recorded against the channel", func() bool {
		return h.channel(id).ErrorCount > 0
	})
}

// The counterpart guard: an ordinary stream must not be scored as a failure,
// including when the model itself writes about errors.
func TestRelayLeavesHealthyStreamsUnflagged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		for _, chunk := range []string{
			`{"choices":[{"delta":{"content":"the error was a missing semicolon"}}],"error":null}`,
			`{"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}`,
		} {
			fmt.Fprintf(w, "data: %s\n\n", chunk)
			flusher.Flush()
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		flusher.Flush()
	})
	id := h.createChannel(channelInput{
		Name: "healthy-stream", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.Error != "" {
		t.Fatalf("a healthy stream was logged as failed: %q", entry.Error)
	}
	if ch := h.channel(id); ch.ErrorCount != 0 {
		t.Fatalf("a healthy stream counted %d channel error(s)", ch.ErrorCount)
	}
}

// Keepalive exists to prove an idle account is still being used, and an error
// delivered inside a 200 proves nothing. It used to count, because the counter
// advances on every request the relay does not call a failure.
func TestKeepaliveIgnoresErrorsInsideAStream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`+"\n\n")
		w.(http.Flusher).Flush()
	})
	id := h.createChannel(channelInput{
		Name: "keepalive-stream-error", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		KeepaliveEnabled: true, KeepaliveAt: "03:00", KeepaliveTarget: 1,
	})
	if err := h.store.OpenKeepaliveWindow(context.Background(), id); err != nil {
		t.Fatal(err)
	}

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"hi"}]}`)
	resp.Body.Close()

	waitFor(t, func() bool { return h.channel(id).ErrorCount > 0 },
		waiting("the in-stream failure to be recorded"))

	ch := h.channel(id)
	if ch.KeepaliveSuccess != 0 {
		t.Fatalf("an in-stream failure advanced the keepalive counter to %d", ch.KeepaliveSuccess)
	}
	if ch.Status != model.StatusEnabled || !ch.KeepaliveOpen {
		t.Fatalf("the window closed on a failure: status %d, open %v", ch.Status, ch.KeepaliveOpen)
	}
}

func TestModelMappingRewritesOnlyTheModelField(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "mapped", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models:       []string{"gpt-4o"},
		ModelMapping: map[string]string{"gpt-4o": "gpt-4o-2024-11-20"},
		Groups:       []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[],"seed":12345678901234567890}`)
	resp.Body.Close()

	want := `{"model":"gpt-4o-2024-11-20","messages":[],"seed":12345678901234567890}`
	if up.body() != want {
		t.Fatalf("mapping mangled the payload:\n got: %s\nwant: %s", up.body(), want)
	}
}

func TestPriorityRoutingAndFailover(t *testing.T) {
	h := newHarness(t)

	broken := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":{"message":"upstream on fire"}}`, http.StatusInternalServerError)
	})
	healthy := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "recovered", 2, 3)
	})

	h.createChannel(channelInput{
		Name: "high-priority-broken", Type: "openai", BaseURL: broken.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100,
	})
	h.createChannel(channelInput{
		Name: "fallback", Type: "openai", BaseURL: healthy.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1,
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("failover did not happen: HTTP %d %s", resp.StatusCode, raw)
	}
	if broken.requests.Load() != 1 {
		t.Errorf("the high-priority channel should have been tried first, got %d calls",
			broken.requests.Load())
	}
	if healthy.requests.Load() != 1 {
		t.Errorf("the fallback channel should have served the request, got %d calls",
			healthy.requests.Load())
	}
}

// The console edits priority and weight straight from the channel table, which
// has no plaintext credential to send back. That is why they get a narrow
// endpoint rather than reusing the full update: this test pins both halves of
// the deal — the change has to reach the selector, and the upstream key has to
// survive it.
func TestChannelRoutingEditMovesTrafficAndKeepsTheCredential(t *testing.T) {
	h := newHarness(t)

	preferred := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from the preferred channel", 2, 3)
	})
	promoted := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from the promoted channel", 2, 3)
	})

	h.createChannel(channelInput{
		Name: "incumbent", Type: "openai", BaseURL: preferred.URL, APIKey: "sk-incumbent",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 100, Weight: 1,
	})
	id := h.createChannel(channelInput{
		Name: "challenger", Type: "openai", BaseURL: promoted.URL, APIKey: "sk-challenger",
		Models: []string{"gpt-4o"}, Groups: []string{"default"}, Priority: 1, Weight: 1,
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if preferred.requests.Load() != 1 || promoted.requests.Load() != 0 {
		t.Fatalf("the higher priority channel should have served the call, got %d and %d",
			preferred.requests.Load(), promoted.requests.Load())
	}

	// Weight 0 goes in deliberately: selection treats weight as a share of the
	// draw, so the server clamps it rather than leaving a channel that is
	// enabled but can never be picked.
	var updated model.Channel
	resp = h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/routing", id), h.admin,
		map[string]any{"priority": 500, "weight": 0}, &updated)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("routing update: HTTP %d, want 200", resp.StatusCode)
	}
	if updated.Priority != 500 || updated.Weight != 1 {
		t.Fatalf("stored priority %d weight %d, want 500 and the clamped 1",
			updated.Priority, updated.Weight)
	}
	if updated.APIKey == "sk-challenger" {
		t.Fatal("the response exposed the upstream key")
	}

	// The routing rows carry their own copy of both numbers, so a write that
	// only touched the channel row would leave the selector on the old order.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if promoted.requests.Load() != 1 {
		t.Fatalf("the promoted channel was not selected, got %d calls", promoted.requests.Load())
	}
	if preferred.requests.Load() != 1 {
		t.Fatalf("the demoted channel served %d calls, want the original 1",
			preferred.requests.Load())
	}

	// The listing only ever holds a masked key. Had the console reused the full
	// update, that mask is what would now be encrypted in the database.
	var cred struct {
		APIKey string `json:"api_key"`
	}
	resp = h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d/credential", id),
		h.admin, nil, &cred)
	resp.Body.Close()
	if cred.APIKey != "sk-challenger" {
		t.Fatalf("credential is now %q, want the original upstream key", cred.APIKey)
	}
}

func TestClientErrorsAreNotRetriedAndPassThrough(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"unknown parameter: foo","type":"invalid_request_error"}}`)
	})
	h.createChannel(channelInput{
		Name: "a", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "b", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	key := h.createKey()
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o","foo":1}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want the upstream 400 verbatim", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "unknown parameter: foo") {
		t.Fatalf("upstream error body was not passed through: %s", raw)
	}
	if up.requests.Load() != 1 {
		t.Fatalf("a 400 must not be retried, got %d attempts", up.requests.Load())
	}
}

func TestAuthenticationFailuresDoNotAutoDisableAChannel(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":{"message":"bad upstream key"}}`)
	})
	id := h.createChannel(channelInput{
		Name: "keeps-running", BaseURL: up.URL, APIKey: "wrong-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	for attempt := 0; attempt < 3; attempt++ {
		resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
		resp.Body.Close()
	}
	channel, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if channel.Status != model.StatusEnabled {
		t.Fatalf("channel status = %d after authentication failures, want enabled", channel.Status)
	}
}

func TestAnthropicAndGeminiDialects(t *testing.T) {
	h := newHarness(t)

	anthropicUp := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"type":  "message",
			"usage": map[string]int{"input_tokens": 100, "output_tokens": 50},
		})
	})
	geminiUp := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"usageMetadata": map[string]int{
				"promptTokenCount": 20, "candidatesTokenCount": 8, "totalTokenCount": 28,
			},
		})
	})

	h.createChannel(channelInput{
		// Deliberately wrong legacy types: the client endpoint, not this field,
		// must select authentication for relayed requests.
		Name: "anthropic", Type: "openai", BaseURL: anthropicUp.URL, APIKey: "ant-key",
		Models: []string{"claude-sonnet-4-5"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "gemini", Type: "anthropic", BaseURL: geminiUp.URL, APIKey: "goog-key",
		Models:       []string{"gemini-2.5-pro"},
		ModelMapping: map[string]string{"gemini-2.5-pro": "gemini-2.5-pro-preview"},
		Groups:       []string{"default"},
	})
	key := h.createKey()

	t.Run("anthropic uses x-api-key", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-sonnet-4-5","max_tokens":16}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d", resp.StatusCode)
		}
		hdrs := anthropicUp.headers()
		if got := hdrs.Get("X-Api-Key"); got != "ant-key" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := hdrs.Get("Authorization"); got != "" {
			t.Errorf("the caller's bearer token leaked upstream: %q", got)
		}
		if got := hdrs.Get("Anthropic-Version"); got == "" {
			t.Error("anthropic-version header was not supplied")
		}
	})

	t.Run("anthropic count_tokens uses the same path-derived auth", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost, "/v1/messages/count_tokens", key,
			`{"model":"claude-sonnet-4-5","messages":[]}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			raw, _ := io.ReadAll(resp.Body)
			t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
		}
		hdrs := anthropicUp.headers()
		if got := hdrs.Get("X-Api-Key"); got != "ant-key" {
			t.Errorf("x-api-key = %q", got)
		}
		if got := hdrs.Get("Authorization"); got != "" {
			t.Errorf("the caller's bearer token leaked upstream: %q", got)
		}
	})

	t.Run("gemini maps the model in the path", func(t *testing.T) {
		resp := h.relayRequest(http.MethodPost,
			"/v1beta/models/gemini-2.5-pro:generateContent", key, `{"contents":[]}`)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d", resp.StatusCode)
		}
		if got := geminiUp.path(); got != "/v1beta/models/gemini-2.5-pro-preview:generateContent" {
			t.Errorf("path = %q, want the mapped model", got)
		}
		if got := geminiUp.headers().Get("X-Goog-Api-Key"); got != "goog-key" {
			t.Errorf("x-goog-api-key = %q", got)
		}
	})
}

func TestMessagesProtocolConversionToChat(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "converted-ok", 11, 3)
	})
	h.createChannel(channelInput{
		Name: "chat-only", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		SupportedProtocols:    []string{model.ProtocolChatCompletions},
		ConvertMessagesToChat: true,
	})
	key := h.createKey()

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/messages", strings.NewReader(`{
		"model":"gpt-4o","max_tokens":32,"system":"be brief",
		"messages":[{"role":"user","content":"hello"}]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Api-Key", key)
	req.Header.Set("Anthropic-Version", "2023-06-01")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}

	if got := up.path(); got != "/v1/chat/completions" {
		t.Fatalf("upstream path = %q", got)
	}
	if got := up.auth(); got != "Bearer upstream-key" {
		t.Fatalf("upstream authorization = %q", got)
	}
	if got := up.headers().Get("Anthropic-Version"); got != "" {
		t.Fatalf("anthropic-version leaked to chat upstream: %q", got)
	}
	var upstreamBody struct {
		Model    string `json:"model"`
		Messages []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(up.body()), &upstreamBody); err != nil {
		t.Fatal(err)
	}
	if upstreamBody.Model != "gpt-4o" || len(upstreamBody.Messages) != 2 ||
		upstreamBody.Messages[0].Role != "system" || upstreamBody.Messages[1].Content != "hello" {
		t.Fatalf("converted upstream body = %+v", upstreamBody)
	}

	var response struct {
		Type    string `json:"type"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "message" || len(response.Content) != 1 ||
		response.Content[0].Text != "converted-ok" || response.Usage.Input != 11 || response.Usage.Output != 3 {
		t.Fatalf("converted response = %+v", response)
	}
}

func TestResponsesProtocolConversionToChat(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "responses-converted", 13, 5)
	})
	h.createChannel(channelInput{
		Name: "responses-chat-only", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
		SupportedProtocols:     []string{model.ProtocolChatCompletions},
		ConvertResponsesToChat: true,
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/responses", key, `{
		"model":"gpt-4o","max_output_tokens":32,"instructions":"be brief","input":"hello"
	}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("HTTP %d: %s", resp.StatusCode, raw)
	}
	if got := up.path(); got != "/v1/chat/completions" {
		t.Fatalf("upstream path = %q", got)
	}
	if got := up.auth(); got != "Bearer upstream-key" {
		t.Fatalf("upstream authorization = %q", got)
	}
	var upstreamBody struct {
		Model     string `json:"model"`
		MaxTokens int    `json:"max_tokens"`
		Messages  []struct {
			Role    string `json:"role"`
			Content string `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal([]byte(up.body()), &upstreamBody); err != nil {
		t.Fatal(err)
	}
	if upstreamBody.Model != "gpt-4o" || upstreamBody.MaxTokens != 32 ||
		len(upstreamBody.Messages) != 2 || upstreamBody.Messages[0].Role != "system" ||
		upstreamBody.Messages[1].Content != "hello" {
		t.Fatalf("converted upstream body = %+v", upstreamBody)
	}
	var response struct {
		Object     string `json:"object"`
		Status     string `json:"status"`
		OutputText string `json:"output_text"`
		Usage      struct {
			Input  int `json:"input_tokens"`
			Output int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&response); err != nil {
		t.Fatal(err)
	}
	if response.Object != "response" || response.Status != "completed" ||
		response.OutputText != "responses-converted" || response.Usage.Input != 13 || response.Usage.Output != 5 {
		t.Fatalf("converted response = %+v", response)
	}
}

// Gemini SDKs authenticate with ?key=..., so the relay must accept the key
// there — and must never forward it to the upstream.
func TestGeminiQueryKeyIsAcceptedButNeverForwarded(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1}}`)
	})
	h.createChannel(channelInput{
		Name: "gemini", Type: "gemini", BaseURL: up.URL, APIKey: "goog-key",
		Models: []string{"gemini-2.5-flash"}, Groups: []string{"default"},
	})
	key := h.createKey()

	target := fmt.Sprintf("%s/v1beta/models/gemini-2.5-flash:generateContent?key=%s&alt=sse",
		h.server.URL, key)
	req, _ := http.NewRequest(http.MethodPost, target, strings.NewReader(`{"contents":[]}`))
	req.Header.Set("Content-Type", "application/json")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("query-string auth was rejected: HTTP %d %s", resp.StatusCode, raw)
	}
	if strings.Contains(up.path(), "key=") {
		t.Fatalf("the caller's relay key leaked to the upstream: %s", up.path())
	}
	if !strings.Contains(up.path(), "alt=sse") {
		t.Errorf("unrelated query parameters must survive: %s", up.path())
	}
	if got := up.headers().Get("X-Goog-Api-Key"); got != "goog-key" {
		t.Errorf("upstream credential = %q, want the channel key", got)
	}
}

func TestModelListingReflectsChannelsAndGroups(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "public", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o", "gpt-4o-mini"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "vip-only", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"o3-pro"}, Groups: []string{"vip"},
	})

	key := h.createKey()
	req, _ := http.NewRequest(http.MethodGet, h.server.URL+"/v1/models", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var listing struct {
		Data []struct{ ID string } `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&listing); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, m := range listing.Data {
		got[m.ID] = true
	}
	if !got["gpt-4o"] || !got["gpt-4o-mini"] {
		t.Errorf("default group models missing: %v", got)
	}
	if got["o3-pro"] {
		t.Error("a model from another group leaked into the listing")
	}
}

func TestFetchModelsFromUpstream(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"object": "list",
			"data": []map[string]string{
				{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}, {"id": "o3"},
			},
		})
	})
	id := h.createChannel(channelInput{
		Name: "pullable", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Groups: []string{"default"},
	})

	var pulled struct {
		Models  []string `json:"models"`
		Count   int      `json:"count"`
		Applied bool     `json:"applied"`
	}
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/fetch-models?apply=true", id), h.admin, nil, &pulled)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
	if pulled.Count != 3 || !pulled.Applied {
		t.Fatalf("unexpected pull result: %+v", pulled)
	}
	if up.path() != "/v1/models" {
		t.Errorf("model catalogue path = %q", up.path())
	}

	// Applying the pull must make the models routable immediately.
	models, err := h.store.GroupModels(context.Background(), "default")
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 3 {
		t.Fatalf("routing table not refreshed, got %v", models)
	}
}

func TestFetchModelsAutoTriesGoogleCatalogueAuthentication(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1beta/models" ||
			r.Header.Get("X-Goog-Api-Key") != "opaque-key" {
			http.Error(w, `{"error":"wrong catalogue authentication"}`, http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"models":[{"name":"models/gemini-2.5-pro"}]}`)
	})
	id := h.createChannel(channelInput{
		Name: "google-catalogue", BaseURL: up.URL, AuthStyle: model.AuthStyleAuto,
		APIKey: "opaque-key", Groups: []string{"default"},
	})

	var pulled struct {
		Models []string `json:"models"`
		Count  int      `json:"count"`
	}
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/fetch-models", id), h.admin, nil, &pulled)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d", resp.StatusCode)
	}
	if pulled.Count != 1 || !slices.Equal(pulled.Models, []string{"gemini-2.5-pro"}) {
		t.Fatalf("unexpected pull result: %+v", pulled)
	}
	if got := up.requests.Load(); got != 3 {
		t.Fatalf("catalogue attempts = %d, want bearer, x-api-key, then Google", got)
	}
	if got := up.path(); got != "/v1beta/models?pageSize=1000" {
		t.Fatalf("last catalogue path = %q", got)
	}
}

func TestQuotaEnforcementAndSettlement(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1_000_000, 0) // $2.50 worth of gpt-4o input
	})
	h.createChannel(channelInput{
		Name: "expensive", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// A fresh user starts with $1.00.
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "spender", Password: "password123"}, &session)

	var created struct {
		Key string `json:"key"`
	}
	h.do(http.MethodPost, "/api/tokens", session.Token,
		tokenInput{Name: "k", UnlimitedQuota: true}, &created)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key, `{"model":"gpt-4o"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("first request should succeed, got %d", resp.StatusCode)
	}

	h.waitForLog(t, 1)
	h.waitFor(t, "balance to go negative", func() bool {
		user, err := h.store.GetUser(context.Background(), session.User.ID)
		return err == nil && user.Quota <= 0
	})

	// The overspent account must be locked out of further requests.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", created.Key, `{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPaymentRequired {
		t.Fatalf("status = %d, want 402 once the balance is exhausted", resp.StatusCode)
	}
}

func TestUnknownModelIsRejected(t *testing.T) {
	h := newHarness(t)
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"nope"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

// ------------------------------------------------------- unpriced models

// unpricedHarness wires a channel serving a model nobody has priced.
func unpricedHarness(t *testing.T) (*harness, *upstream, string) {
	t.Helper()
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1000, 500)
	})
	h.createChannel(channelInput{
		Name: "exotic", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"deepseek-v3"}, Groups: []string{"default"},
	})
	return h, up, h.createKey()
}

func TestUnpricedModelIsRefusedByDefault(t *testing.T) {
	h, up, key := unpricedHarness(t)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a model with no price", resp.StatusCode)
	}
	// The refusal must happen before any upstream tokens are spent.
	if got := up.requests.Load(); got != 0 {
		t.Fatalf("the upstream was called %d time(s); an unpriced model must never be relayed", got)
	}

	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "model_not_priced") {
		t.Fatalf("error payload does not name the cause: %s", raw)
	}

	// A priced model on the same gateway keeps working.
	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "deepseek-v3", InputPrice: 0.27, OutputPrice: 1.1}, nil)

	resp2 := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 once the model is priced", resp2.StatusCode)
	}

	// Both the refusal and the successful call are logged; the settlement
	// goroutines race, so pick the entry by status rather than by position.
	h.waitForLog(t, 2)
	entry := h.logByStatus(t, http.StatusOK)

	// 1000 * 0.27 + 500 * 1.1 = 820 micro-USD.
	if entry.Cost != 820 {
		t.Fatalf("cost = %d micro-USD, want 820", entry.Cost)
	}
}

func TestFallbackPolicyBillsUnpricedModels(t *testing.T) {
	h, up, key := unpricedHarness(t)

	settings := billing.Settings{
		UnpricedPolicy: billing.PolicyFallback,
		Fallback:       billing.FallbackPrice{InputPrice: 1, OutputPrice: 3},
	}
	if resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin, settings, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("update billing settings: HTTP %d", resp.StatusCode)
	}

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 under the fallback policy", resp.StatusCode)
	}
	if got := up.requests.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}

	// 1000 * $1/1M + 500 * $3/1M = 2500 micro-USD, charged to the caller.
	entry := h.waitForLog(t, 1)
	if entry.Cost != 2500 {
		t.Fatalf("cost = %d micro-USD, want 2500", entry.Cost)
	}
	h.waitFor(t, "the balance to be debited", func() bool {
		user, err := h.store.GetUser(context.Background(), entry.UserID)
		return err == nil && user.UsedQuota == 2500
	})
}

func TestFreePolicyRestoresTheOldBehaviour(t *testing.T) {
	h, _, key := unpricedHarness(t)

	settings := billing.Settings{UnpricedPolicy: billing.PolicyFree}
	if resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin, settings, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("update billing settings: HTTP %d", resp.StatusCode)
	}

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 under the free policy", resp.StatusCode)
	}

	entry := h.waitForLog(t, 1)
	if entry.Cost != 0 {
		t.Fatalf("cost = %d, want 0 under the free policy", entry.Cost)
	}
	// Usage is still recorded even though nothing is charged.
	if entry.TotalTokens != 1500 {
		t.Fatalf("total_tokens = %d, want 1500", entry.TotalTokens)
	}
}

func TestBillingSettingsRejectAnUnchargeableFallback(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin,
		billing.Settings{UnpricedPolicy: billing.PolicyFallback}, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a fallback policy with no prices", resp.StatusCode)
	}

	resp2 := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin,
		billing.Settings{UnpricedPolicy: "nonsense"}, nil)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown policy", resp2.StatusCode)
	}

	// The rejected writes must not have changed anything.
	var current billing.Settings
	h.do(http.MethodGet, "/api/admin/billing/settings", h.admin, nil, &current)
	if current.UnpricedPolicy != billing.PolicyReject {
		t.Fatalf("policy = %q, want it unchanged at %q", current.UnpricedPolicy, billing.PolicyReject)
	}
}

func TestUnpricedModelsAudit(t *testing.T) {
	h, _, _ := unpricedHarness(t)

	var report struct {
		Data  []string `json:"data"`
		Total int      `json:"total"`
	}
	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)

	if report.Total != 1 || len(report.Data) != 1 || report.Data[0] != "deepseek-v3" {
		t.Fatalf("audit = %+v, want just deepseek-v3", report)
	}

	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "deepseek-v3", InputPrice: 0.27}, nil)

	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)
	if report.Total != 0 {
		t.Fatalf("audit still reports %v after pricing the model", report.Data)
	}
}

func TestRelayRejectsBadKeys(t *testing.T) {
	h := newHarness(t)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", "sk-nonsense", `{"model":"gpt-4o"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

func TestNonAdminCannotReachAdminEndpoints(t *testing.T) {
	h := newHarness(t)

	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/register", "",
		credentials{Username: "peon", Password: "password123"}, &session)

	resp := h.do(http.MethodGet, "/api/admin/channels", session.Token, nil, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", resp.StatusCode)
	}
}

func TestChannelKeysAreEncryptedAtRestAndMaskedInTheAPI(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "secretive", Type: "openai", BaseURL: "https://example.invalid",
		APIKey: "sk-super-secret-value", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var stored string
	if err := h.pool.QueryRow(context.Background(),
		`SELECT api_key_enc FROM channels WHERE id = $1`, id).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "super-secret") {
		t.Fatal("the upstream credential was stored in plaintext")
	}

	var fetched model.Channel
	h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, nil, &fetched)
	if strings.Contains(fetched.APIKey, "super-secret") {
		t.Fatalf("the API returned the raw credential: %q", fetched.APIKey)
	}

	// An empty api_key on update must preserve the stored one.
	h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, channelInput{
		Name: "secretive", Type: "openai", BaseURL: "https://example.invalid",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	}, nil)

	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.APIKey != "sk-super-secret-value" {
		t.Fatalf("the credential was lost on update: %q", ch.APIKey)
	}
}

func TestPrefixRoutingOnlyAppliesWhenNoExactChannelMatches(t *testing.T) {
	h := newHarness(t)

	exact := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-exact", 1, 1)
	})
	prefix := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "from-prefix", 1, 1)
	})

	h.createChannel(channelInput{
		Name: "exact", Type: "openai", BaseURL: exact.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "prefix", Type: "openai", BaseURL: prefix.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// An explicitly listed model must never be stolen by a catch-all prefix.
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if !strings.Contains(string(raw), "from-exact") {
		t.Fatalf("prefix channel stole an exact match: %s", raw)
	}

	// A model nobody lists falls through to the prefix channel.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4.1-mini"}`)
	raw, _ = io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !strings.Contains(string(raw), "from-prefix") {
		t.Fatalf("prefix route did not answer: HTTP %d %s", resp.StatusCode, raw)
	}

	// A model outside every prefix still has no route.
	resp = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"claude-sonnet-4"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unrelated model status = %d, want 404", resp.StatusCode)
	}
}

func TestDisabledChannelDropsOutOfPrefixRouting(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "prefix", Type: "openai", BaseURL: up.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, Groups: []string{"default"},
	})
	key := h.createKey()

	h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d/status", id), h.admin,
		map[string]any{"status": 2}, nil)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4.1"}`)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("a disabled channel still served a prefix route: HTTP %d", resp.StatusCode)
	}
}

func TestChannelModelFilterMatchesFragments(t *testing.T) {
	h := newHarness(t)

	h.createChannel(channelInput{
		Name: "claude-house", Type: "anthropic", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"claude-opus-5", "claude-sonnet-5"}, Groups: []string{"default"},
	})
	h.createChannel(channelInput{
		Name: "gpt-house", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	// A prefix channel serves the family without listing any model name.
	h.createChannel(channelInput{
		Name: "prefix-house", Type: "anthropic", BaseURL: "https://example.invalid", APIKey: "k",
		ModelPrefixes: []string{"claude-"}, Groups: []string{"default"},
	})
	// A literal percent sign must stay literal rather than acting as a wildcard.
	h.createChannel(channelInput{
		Name: "odd-house", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"weird%model"}, Groups: []string{"default"},
	})

	names := func(query string) []string {
		t.Helper()
		var listed page[*model.Channel]
		h.do(http.MethodGet, "/api/admin/channels?page_size=50&"+query, h.admin, nil, &listed)
		out := make([]string, 0, len(listed.Data))
		for _, channel := range listed.Data {
			out = append(out, channel.Name)
		}
		sort.Strings(out)
		return out
	}

	// A fragment matches both an exact model list and a prefix entry.
	got := names("model=claude")
	want := []string{"claude-house", "prefix-house"}
	if !slices.Equal(got, want) {
		t.Fatalf("model=claude -> %v, want %v", got, want)
	}

	// Case-insensitive, and a mid-string fragment still matches.
	if got := names("model=OPUS"); !slices.Equal(got, []string{"claude-house"}) {
		t.Fatalf("model=OPUS -> %v", got)
	}

	// A full name keeps working, so the filter stays a superset of the old one.
	if got := names("model=gpt-4o"); !slices.Equal(got, []string{"gpt-house"}) {
		t.Fatalf("model=gpt-4o -> %v", got)
	}

	if got := names("model=nothing-here"); len(got) != 0 {
		t.Fatalf("unmatched fragment returned %v", got)
	}

	// "%" would match everything if the term were treated as a LIKE pattern.
	if got := names("model=%25"); !slices.Equal(got, []string{"odd-house"}) {
		t.Fatalf("a literal %% was treated as a wildcard: %v", got)
	}
}

func TestChannelNamesAreUnique(t *testing.T) {
	h := newHarness(t)

	in := channelInput{
		Name: "duplicate", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	}
	h.createChannel(in)

	resp := h.do(http.MethodPost, "/api/admin/channels", h.admin, in, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("duplicate name status = %d, want 409", resp.StatusCode)
	}
}

func TestUpdateChannelRejectsAnEmptyName(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "named", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPut, fmt.Sprintf("/api/admin/channels/%d", id), h.admin,
		channelInput{Name: "  ", Type: "openai", Models: []string{"gpt-4o"}}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("blank name status = %d, want 400", resp.StatusCode)
	}

	ch, err := h.store.GetChannel(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if ch.Name != "named" {
		t.Fatalf("the name was overwritten: %q", ch.Name)
	}
}

func TestCloneChannelCopiesTheCredentialAndStaysDisabled(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "origin", Type: "openai", BaseURL: "https://example.invalid",
		APIKey: "sk-original-secret", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var clone model.Channel
	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin, nil, &clone)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("clone status = %d, want 201", resp.StatusCode)
	}
	if clone.Name != "origin 副本" {
		t.Fatalf("clone name = %q", clone.Name)
	}
	if clone.Status != model.StatusDisabled {
		t.Fatalf("a clone must start disabled, got status %d", clone.Status)
	}
	if strings.Contains(clone.APIKey, "original") {
		t.Fatalf("the clone response leaked the credential: %q", clone.APIKey)
	}

	stored, err := h.store.GetChannel(context.Background(), clone.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.APIKey != "sk-original-secret" {
		t.Fatalf("the credential was not copied: %q", stored.APIKey)
	}

	// Cloning twice must not collide on the generated name.
	var second model.Channel
	resp = h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/clone", id), h.admin, nil, &second)
	resp.Body.Close()
	if second.Name != "origin 副本 2" {
		t.Fatalf("second clone name = %q", second.Name)
	}
}

func TestBatchStatusAndDeleteChannels(t *testing.T) {
	h := newHarness(t)

	first := h.createChannel(channelInput{
		Name: "bulk-a", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	second := h.createChannel(channelInput{
		Name: "bulk-b", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	ids := []int64{first, second}

	var disabled struct {
		Updated int64 `json:"updated"`
	}
	h.do(http.MethodPost, "/api/admin/channels/batch/status", h.admin,
		map[string]any{"ids": ids, "status": 2}, &disabled)
	if disabled.Updated != 2 {
		t.Fatalf("updated = %d, want 2", disabled.Updated)
	}

	// Routing must follow the bulk switch, not just the channel rows.
	candidates, err := h.store.Candidates(context.Background(), "default", "gpt-4o", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("disabled channels are still routable: %+v", candidates)
	}

	var removed struct {
		Deleted int64 `json:"deleted"`
	}
	h.do(http.MethodPost, "/api/admin/channels/batch/delete", h.admin,
		map[string]any{"ids": ids}, &removed)
	if removed.Deleted != 2 {
		t.Fatalf("deleted = %d, want 2", removed.Deleted)
	}
}

func TestBatchActionsRejectAnEmptySelection(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels/batch/delete", h.admin,
		map[string]any{"ids": []int64{}}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty selection status = %d, want 400", resp.StatusCode)
	}
}

func TestConfiguredTestModelIsUsedByTheProbe(t *testing.T) {
	h := newHarness(t)

	var probed atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		probed.Store(u.body())
		chatResponse(w, "ok", 1, 1)
	})
	id := h.createChannel(channelInput{
		Name: "probe", Type: "openai", BaseURL: up.URL, APIKey: "k",
		ModelPrefixes: []string{"gpt-4"}, TestModel: "gpt-4o-mini",
		Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin, nil, &result)
	if !result.OK {
		t.Fatalf("probe failed: %+v", result)
	}
	if body, _ := probed.Load().(string); !strings.Contains(body, "gpt-4o-mini") {
		t.Fatalf("the configured test model was not used: %s", body)
	}
}

// createRedemptions generates a batch and returns the codes.
func (h *harness) createRedemptions(t *testing.T, amountUSD float64, count int) []string {
	t.Helper()
	var created struct {
		Data []model.Redemption `json:"data"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin,
		map[string]any{"name": "test", "amount_usd": amountUSD, "count": count}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || len(created.Data) != count {
		t.Fatalf("create redemptions: HTTP %d with %d codes", resp.StatusCode, len(created.Data))
	}
	codes := make([]string, 0, count)
	for _, entry := range created.Data {
		codes = append(codes, entry.Code)
	}
	return codes
}

// A spent code is the only record that a balance was ever credited: there is
// no ledger behind it, so deleting one would leave money in an account with
// nothing to explain where it came from. It also frees the per-campaign slot,
// letting the same user claim a second code from the group.
func TestDeletingRedemptionsKeepsSpentOnes(t *testing.T) {
	h := newHarness(t)

	codes := h.createRedemptions(t, 1, 3)
	all := h.listRedemptions(t)
	if len(all) != 3 {
		t.Fatalf("expected 3 codes, got %d", len(all))
	}

	// Spend the first one.
	resp := h.do(http.MethodPost, "/api/redeem", h.admin, map[string]any{"code": codes[0]}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("redeem: HTTP %d", resp.StatusCode)
	}

	ids := make([]int64, 0, len(all))
	for _, entry := range all {
		ids = append(ids, entry.ID)
	}

	// Ask for all three, including the spent one.
	var result struct {
		Deleted int64 `json:"deleted"`
	}
	resp = h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": ids}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete: HTTP %d", resp.StatusCode)
	}
	if result.Deleted != 2 {
		t.Fatalf("deleted %d, want 2 — the spent code must be kept", result.Deleted)
	}

	remaining := h.listRedemptions(t)
	if len(remaining) != 1 {
		t.Fatalf("%d codes remain, want only the spent one", len(remaining))
	}
	kept := remaining[0]
	if kept.Code != codes[0] || kept.Status != model.RedemptionUsed {
		t.Fatalf("the wrong code survived: %+v", kept)
	}
	// The audit trail has to be intact, not merely the row.
	if kept.UsedByName == "" || kept.UsedAt == nil {
		t.Fatalf("the record of who was credited was lost: %+v", kept)
	}
}

// Deleting one code at a time is the same endpoint with a selection of one,
// which is what the row action in the console sends.
func TestDeletingASingleRedemption(t *testing.T) {
	h := newHarness(t)

	h.createRedemptions(t, 1, 2)
	all := h.listRedemptions(t)

	var result struct {
		Deleted int64 `json:"deleted"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": []int64{all[0].ID}}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || result.Deleted != 1 {
		t.Fatalf("delete one: HTTP %d deleted %d", resp.StatusCode, result.Deleted)
	}
	if remaining := h.listRedemptions(t); len(remaining) != 1 {
		t.Fatalf("%d codes remain, want 1", len(remaining))
	}
}

// An empty selection is a mistake, not a request to delete nothing, and the
// message has to name what the caller was actually selecting.
func TestDeletingRedemptionsRejectsAnEmptySelection(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": []int64{}}, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty selection: HTTP %d, want 400", resp.StatusCode)
	}
	if strings.Contains(string(body), "渠道") {
		t.Fatalf("the redemption endpoint reported a channel error: %s", body)
	}
}

func TestRedemptionCreditsTheUserOnce(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "spender", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "spender", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "spender")
	if err != nil {
		t.Fatal(err)
	}
	code := h.createRedemptions(t, 5, 1)[0]

	var result struct {
		Quota   int64 `json:"quota"`
		Balance int64 `json:"balance"`
	}
	resp := h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": code}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("redeem: HTTP %d", resp.StatusCode)
	}
	if result.Quota != billing.ParseUSD(5) {
		t.Fatalf("credited %d micro-USD, want %d", result.Quota, billing.ParseUSD(5))
	}
	if result.Balance != before.Quota+billing.ParseUSD(5) {
		t.Fatalf("balance = %d, want %d", result.Balance, before.Quota+billing.ParseUSD(5))
	}

	// Case and padding must not matter, but a spent code stays spent.
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "  " + strings.ToLower(code) + "  "}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second redeem: HTTP %d, want 409", resp.StatusCode)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "spender")
	if err != nil {
		t.Fatal(err)
	}
	if after.Quota != before.Quota+billing.ParseUSD(5) {
		t.Fatalf("balance moved twice: %d", after.Quota)
	}
}

// The interesting failure mode: the same code submitted concurrently must
// credit exactly once, or a code becomes an unlimited money printer.
func TestConcurrentRedemptionCreditsExactlyOnce(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "racer", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "racer", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "racer")
	if err != nil {
		t.Fatal(err)
	}
	code := h.createRedemptions(t, 10, 1)[0]

	const attempts = 8
	var wg sync.WaitGroup
	statuses := make([]int, attempts)
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			resp := h.do(http.MethodPost, "/api/redeem", session.Token,
				map[string]any{"code": code}, nil)
			resp.Body.Close()
			statuses[i] = resp.StatusCode
		}(i)
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d of %d concurrent redemptions succeeded, want exactly 1", succeeded, attempts)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "racer")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := after.Quota-before.Quota, billing.ParseUSD(10); got != want {
		t.Fatalf("balance moved by %d micro-USD, want %d", got, want)
	}
}

// Two different codes from one group, submitted concurrently: the database
// index is what makes this safe, since checking the user's history first and
// claiming afterwards would let both through.
func TestGroupedRedemptionsAreOnePerUser(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "claimer", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "claimer", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "claimer")
	if err != nil {
		t.Fatal(err)
	}

	var created struct {
		Data []model.Redemption `json:"data"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin, map[string]any{
		"group": "double-eleven", "amount_usd": 2, "count": 4,
	}, &created)
	resp.Body.Close()
	if len(created.Data) != 4 {
		t.Fatalf("generated %d codes", len(created.Data))
	}

	var wg sync.WaitGroup
	statuses := make([]int, len(created.Data))
	start := make(chan struct{})
	for i, entry := range created.Data {
		wg.Add(1)
		go func(i int, code string) {
			defer wg.Done()
			<-start
			resp := h.do(http.MethodPost, "/api/redeem", session.Token,
				map[string]any{"code": code}, nil)
			resp.Body.Close()
			statuses[i] = resp.StatusCode
		}(i, entry.Code)
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d of 4 grouped codes were claimed, want exactly 1 (%v)", succeeded, statuses)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "claimer")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := after.Quota-before.Quota, billing.ParseUSD(2); got != want {
		t.Fatalf("balance moved by %d, want %d", got, want)
	}

	// A later, unhurried attempt at the same group is refused too.
	remaining := ""
	for i, entry := range created.Data {
		if statuses[i] != http.StatusOK {
			remaining = entry.Code
			break
		}
	}
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": remaining}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("sequential second claim: HTTP %d, want 409", resp.StatusCode)
	}

	// A different user is unaffected, and ungrouped codes stay unrestricted.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "other", "password": "password123",
	}, nil)
	var otherSession sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "other", Password: "password123"}, &otherSession)
	resp = h.do(http.MethodPost, "/api/redeem", otherSession.Token,
		map[string]any{"code": remaining}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a second user was blocked by someone else's claim: HTTP %d", resp.StatusCode)
	}

	loose := h.createRedemptions(t, 1, 2)
	for _, code := range loose {
		resp := h.do(http.MethodPost, "/api/redeem", session.Token,
			map[string]any{"code": code}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("ungrouped code was refused: HTTP %d", resp.StatusCode)
		}
	}
}

func TestRedemptionRejectsUnusableCodes(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "picky", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "picky", Password: "password123"}, &session)

	// Unknown.
	resp := h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "AAAAA-BBBBB-CCCCC-DDDDD"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown code: HTTP %d, want 404", resp.StatusCode)
	}

	// Disabled.
	codes := h.createRedemptions(t, 1, 1)
	listed := h.listRedemptions(t)
	resp = h.do(http.MethodPut,
		fmt.Sprintf("/api/admin/redemptions/%d/status", listed[0].ID), h.admin,
		map[string]any{"status": model.RedemptionDisabled}, nil)
	resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": codes[0]}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("disabled code: HTTP %d, want 403", resp.StatusCode)
	}

	// Expired: written straight to the store, since the API refuses to create
	// a code that is already in the past.
	past := time.Now().Add(-time.Hour)
	if _, err := h.store.CreateRedemptions(context.Background(), []*model.Redemption{{
		Code: "EXPIR-EDCOD-EEEEE-11111", Quota: billing.ParseUSD(1), ExpiresAt: &past,
	}}); err != nil {
		t.Fatal(err)
	}
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "EXPIR-EDCOD-EEEEE-11111"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expired code: HTTP %d, want 403", resp.StatusCode)
	}

	// A regular user cannot mint credit.
	resp = h.do(http.MethodPost, "/api/admin/redemptions", session.Token,
		map[string]any{"amount_usd": 100, "count": 1}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("user minted codes: HTTP %d, want 403", resp.StatusCode)
	}

	// Zero or negative value is refused.
	for _, amount := range []float64{0, -5} {
		resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin,
			map[string]any{"amount_usd": amount, "count": 1}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("amount %v accepted: HTTP %d", amount, resp.StatusCode)
		}
	}
}

func (h *harness) listRedemptions(t *testing.T) []*model.Redemption {
	t.Helper()
	var listed page[*model.Redemption]
	h.do(http.MethodGet, "/api/admin/redemptions?page_size=100", h.admin, nil, &listed)
	return listed.Data
}

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

func (h *harness) consoleSettings(t *testing.T) consoleSettings {
	t.Helper()
	var settings consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	return settings
}

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

// The point of the feature: after a call, its full request and reply can be
// read back, and what is stored is the body of that call rather than some
// other call in the same conversation.
func TestRequestDetailKeepsEachCallsOwnBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, fmt.Sprintf("reply-%d", u.requests.Load()), 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	// Same session id on both calls, to be sure the bodies are stored per
	// call rather than collapsed into one record per conversation.
	for _, prompt := range []string{"first-question", "second-question"} {
		req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
			strings.NewReader(`{"model":"gpt-4o","messages":[{"role":"user","content":"`+prompt+`"}]}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+key)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Session-ID", "shared-session")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		resp := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		resp.Body.Close()
		return len(listed.Data) >= 2
	}, waiting("two log rows"))

	// Newest first, so the second call is listed first.
	for index, want := range []string{"second-question", "first-question"} {
		entry := listed.Data[index]
		// The bodies are written just after the log row they belong to, so a
		// list that already has the row can still be a moment ahead of them.
		var detail model.RequestLogDetail
		var status int
		waitFor(t, func() bool {
			resp := h.do(http.MethodGet,
				fmt.Sprintf("/api/admin/logs/%d/detail", entry.ID), h.admin, nil, &detail)
			resp.Body.Close()
			status = resp.StatusCode
			return status == http.StatusOK
		}, func() string {
			return fmt.Sprintf("detail for log %d, last saw HTTP %d", entry.ID, status)
		})
		if !strings.Contains(detail.RequestBody, want) {
			t.Fatalf("log %d holds the wrong request: want %q in %s",
				entry.ID, want, detail.RequestBody)
		}
		if detail.ResponseBody == "" {
			t.Fatalf("log %d kept no response body", entry.ID)
		}
	}
}

// Credentials must not survive into the stored bodies: the whole request is
// kept, so anything sensitive in it would be kept too.
func TestRequestDetailRedactsCredentials(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","api_key":"sk-should-not-be-stored"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the log row"))

	var detail model.RequestLogDetail
	r := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[0].ID), h.admin, nil, &detail)
	r.Body.Close()

	if strings.Contains(detail.RequestBody, "sk-should-not-be-stored") {
		t.Fatalf("a credential in the body was stored verbatim: %s", detail.RequestBody)
	}
	if raw, _ := json.Marshal(detail.RequestHeaders); strings.Contains(string(raw), key) {
		t.Fatalf("the caller's key was stored in the headers: %s", raw)
	}
}

// The window is the whole point: bodies are large, so the table must stay
// bounded no matter how much traffic passes through.
func TestRequestDetailWindowDropsTheOldest(t *testing.T) {
	h := newHarness(t)

	settings := h.settings(t)
	settings.LogDetailKeep = 3
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set window: HTTP %d", resp.StatusCode)
	}

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	const calls = 6
	for range calls {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
		_, _ = io.Copy(io.Discard, r.Body)
		r.Body.Close()
	}

	// Every call has to be logged before the window can be judged: the detail
	// count reaches 3 while later calls are still being written, so waiting on
	// it alone would inspect a half-finished picture.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= calls
	}, func() string { return fmt.Sprintf("%d log rows, saw %d", calls, len(listed.Data)) })

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 3
	}, func() string { return fmt.Sprintf("the window to settle at 3 rows, saw %d", stored) })

	newest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[0].ID), h.admin, nil, nil)
	newest.Body.Close()
	if newest.StatusCode != http.StatusOK {
		t.Fatalf("the newest call lost its bodies: HTTP %d", newest.StatusCode)
	}

	oldest := h.do(http.MethodGet,
		fmt.Sprintf("/api/admin/logs/%d/detail", listed.Data[calls-1].ID), h.admin, nil, nil)
	oldest.Body.Close()
	if oldest.StatusCode != http.StatusGone {
		t.Fatalf("the oldest call still has bodies: HTTP %d, want 410", oldest.StatusCode)
	}
}

// Turning the window off has to clear what was already recorded, otherwise
// "stop keeping request bodies" would leave the existing ones on disk.
func TestRequestDetailWindowOfZeroClearsStoredBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 1
	}, waiting("the first body to be recorded"))

	settings := h.settings(t)
	settings.LogDetailKeep = 0
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	// The next call is what applies the change.
	relayed = h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 0
	}, func() string { return fmt.Sprintf("stored bodies to be cleared, saw %d", stored) })
}

// Purging the metadata must take the bodies with it: a body outliving the row
// that says who sent it would be unattributable and unreachable.
func TestPurgingLogsRemovesTheirBodies(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	var stored int
	waitFor(t, func() bool {
		if err := h.pool.QueryRow(context.Background(),
			`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
			t.Fatal(err)
		}
		return stored == 1
	}, waiting("the body to be recorded"))

	// days=0 purges everything up to now.
	resp := h.do(http.MethodDelete, "/api/admin/logs?days=0", h.admin, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("purge: HTTP %d", resp.StatusCode)
	}

	if err := h.pool.QueryRow(context.Background(),
		`SELECT count(*) FROM request_log_details`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != 0 {
		t.Fatalf("%d bodies outlived the purged logs", stored)
	}
}

// The bodies are an operator diagnostic: a regular account must not reach
// them, not even for its own traffic.
func TestRequestDetailIsAdminOnly(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "curious", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "curious", Password: "password123"}, &session)

	resp := h.do(http.MethodGet, "/api/admin/logs/1/detail", session.Token, nil, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("a regular user reached the bodies: HTTP %d", resp.StatusCode)
	}
}

// A rebuild has to serialise against channel writes, because it clears the
// whole routing table and refills it from a list of channels.
//
// Any rebuild that runs to completion while a channel write is in flight has by
// definition built the table from a snapshot that excludes that channel, having
// cleared rows that may include it — so whether the row survives comes down to
// which side commits first. Holding an uncommitted insert pins that ordering:
// the rebuild must wait rather than quietly finish without the channel.
func TestRebuildKeepsAChannelWrittenWhileItRuns(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	h.createChannel(channelInput{
		Name: "existing", Type: "openai", BaseURL: "http://upstream.test", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// Stand in for a CreateChannel that has not committed yet: the channel row
	// and its routing rows, written together as the store writes them.
	tx, err := h.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var racerID int64
	if err := tx.QueryRow(ctx, `INSERT INTO channels
		(name, base_url, auth_style, status, priority, weight, channel_groups, models)
		VALUES ('racer', 'http://upstream.test', 'auto', 1, 0, 1,
		        ARRAY['default'], ARRAY['racer-model'])
		RETURNING id`).Scan(&racerID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO abilities
		(group_name, model, channel_id, priority, weight, enabled)
		VALUES ('default', 'racer-model', $1, 0, 1, TRUE)`, racerID); err != nil {
		t.Fatal(err)
	}

	rebuilt := make(chan int, 1)
	go func() {
		resp := h.do(http.MethodPost, "/api/admin/channels/rebuild", h.admin, nil, nil)
		resp.Body.Close()
		rebuilt <- resp.StatusCode
	}()

	// Give the rebuild time to reach the point where it reads the channel list
	// and starts clearing the table.
	select {
	case status := <-rebuilt:
		t.Fatalf("rebuild finished before the concurrent write committed (HTTP %d); "+
			"it must not be able to skip past an in-flight channel", status)
	case <-time.After(500 * time.Millisecond):
	}

	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	select {
	case status := <-rebuilt:
		if status != http.StatusOK {
			t.Fatalf("rebuild: HTTP %d, want 200", status)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("rebuild never completed")
	}

	for _, tc := range []struct{ name, served string }{
		{"racer", "racer-model"},
		{"existing", "gpt-4o"},
	} {
		candidates, err := h.store.Candidates(ctx, "default", tc.served, "")
		if err != nil {
			t.Fatal(err)
		}
		if len(candidates) == 0 {
			t.Fatalf("%s lost its routing: the rebuild cleared it without writing it back",
				tc.name)
		}
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

// blockRule is the shorthand these tests describe a policy with.
func blockRule(name string, keywords []string, replies []string) relay.BlockRule {
	return relay.BlockRule{Name: name, Enabled: true, Keywords: keywords, Replies: replies}
}

// A blocked request must be refused before an upstream sees it, and the reply
// must not disclose which keyword tripped — that would turn each rejection
// into a probe for mapping the list.
func TestBlockedKeywordRefusesTheRequest(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"forbidden-phrase", "another-one"}, nil),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save keywords: HTTP %d", resp.StatusCode)
	}

	// Mixed case, to be sure matching folds it.
	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"a FORBIDDEN-Phrase here"}]}`)
	body, _ := io.ReadAll(blocked.Body)
	blocked.Body.Close()

	// Answered with the fixed text rather than an error, so the caller sees an
	// ordinary reply. What must never happen is the real model answering.
	if blocked.StatusCode != http.StatusOK {
		t.Fatalf("blocked request: HTTP %d, want 200", blocked.StatusCode)
	}
	if !strings.Contains(string(body), "北国风光") {
		t.Fatalf("the canned reply was not returned: %s", body)
	}
	if strings.Contains(strings.ToLower(string(body)), "forbidden-phrase") {
		t.Fatalf("the reply disclosed the keyword: %s", body)
	}
	if reached.Load() != 0 {
		t.Fatal("a blocked request still reached the upstream")
	}

	// A clean request on the same key still works, so the block is per request
	// rather than a state the key falls into.
	clean := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"perfectly fine"}]}`)
	_, _ = io.Copy(io.Discard, clean.Body)
	clean.Body.Close()
	if clean.StatusCode != http.StatusOK {
		t.Fatalf("clean request: HTTP %d, want 200", clean.StatusCode)
	}

	// The operator needs to see what happened, with the keyword recorded.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &listed)
		r.Body.Close()
		return len(listed.Data) >= 1
	}, waiting("the blocked call to be logged"))
	if !strings.Contains(listed.Data[0].Error, "forbidden-phrase") {
		t.Fatalf("the log does not say which keyword matched: %q", listed.Data[0].Error)
	}
}

// The canned reply has to be in the caller's own dialect and parse as an
// ordinary answer; a reply the client cannot read is worse than a refusal.
func TestBlockedRequestGetsACannedReplyPerDialect(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	for _, ch := range []channelInput{
		{Name: "openai", Type: "openai", BaseURL: up.URL, APIKey: "k",
			Models: []string{"gpt-4o"}, Groups: []string{"default"}},
		{Name: "anthropic", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
			Models: []string{"claude-3"}, Groups: []string{"default"}},
	} {
		h.createChannel(ch)
	}
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	t.Run("openai", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d, want 200", r.StatusCode)
		}
		var parsed struct {
			Choices []struct {
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
			Usage struct {
				PromptTokens     int `json:"prompt_tokens"`
				CompletionTokens int `json:"completion_tokens"`
				TotalTokens      int `json:"total_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("reply is not valid JSON: %v (%s)", err, body)
		}
		if len(parsed.Choices) == 0 || !strings.Contains(parsed.Choices[0].Message.Content, "北国风光") {
			t.Fatalf("unexpected content: %s", body)
		}
		// Zero tokens is what marks a reply as synthetic to anything that
		// reads usage.
		switch {
		case parsed.Usage.PromptTokens == 0:
			t.Fatalf("no prompt tokens reported: %s", body)
		case parsed.Usage.CompletionTokens == 0:
			t.Fatalf("no completion tokens reported: %s", body)
		case parsed.Usage.TotalTokens != parsed.Usage.PromptTokens+parsed.Usage.CompletionTokens:
			t.Fatalf("total does not add up: %+v", parsed.Usage)
		}
	})

	t.Run("anthropic", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-3","messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()
		if r.StatusCode != http.StatusOK {
			t.Fatalf("HTTP %d, want 200", r.StatusCode)
		}
		var parsed struct {
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
			Usage struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			t.Fatalf("reply is not valid JSON: %v (%s)", err, body)
		}
		if parsed.Type != "message" || len(parsed.Content) == 0 ||
			!strings.Contains(parsed.Content[0].Text, "北国风光") {
			t.Fatalf("unexpected anthropic reply: %s", body)
		}
		if parsed.Usage.InputTokens == 0 || parsed.Usage.OutputTokens == 0 {
			t.Fatalf("anthropic reply reported no tokens: %s", body)
		}
	})

	t.Run("openai stream", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","stream":true,"messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		text := string(body)
		if !strings.Contains(text, "data: [DONE]") {
			t.Fatalf("the stream never terminated: %s", text)
		}
		// Every frame has to be readable on its own: a client parses them one
		// at a time, not as one document.
		var assembled strings.Builder
		for _, line := range strings.Split(text, "\n") {
			payload, ok := strings.CutPrefix(line, "data: ")
			if !ok || payload == "[DONE]" {
				continue
			}
			var chunk struct {
				Choices []struct {
					Delta struct{ Content string } `json:"delta"`
				} `json:"choices"`
			}
			if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
				t.Fatalf("unparseable chunk %q: %v", payload, err)
			}
			for _, choice := range chunk.Choices {
				assembled.WriteString(choice.Delta.Content)
			}
		}
		if !strings.Contains(assembled.String(), "数风流人物") {
			t.Fatalf("the streamed text was incomplete: %q", assembled.String())
		}
	})

	t.Run("anthropic stream", func(t *testing.T) {
		r := h.relayRequest(http.MethodPost, "/v1/messages", key,
			`{"model":"claude-3","stream":true,"messages":[{"role":"user","content":"tripwire"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		text := string(body)
		for _, want := range []string{
			"event: message_start", "event: content_block_delta", "event: message_stop",
		} {
			if !strings.Contains(text, want) {
				t.Fatalf("missing %q in the stream: %s", want, text)
			}
		}
		if !strings.Contains(text, "text_delta") || !strings.Contains(text, "\\u5317\\u56fd") &&
			!strings.Contains(text, "北国") {
			t.Fatalf("the stream carried no text: %s", text)
		}
	})

	if reached.Load() != 0 {
		t.Fatalf("%d blocked requests still reached an upstream", reached.Load())
	}

	// Nothing was spent, so nothing may be billed.
	var listed page[*model.RequestLog]
	waitFor(t, func() bool {
		rr := h.do(http.MethodGet, "/api/admin/logs", h.admin, nil, &listed)
		rr.Body.Close()
		return len(listed.Data) >= 4
	}, waiting("the blocked calls to be logged"))
	for _, entry := range listed.Data {
		if entry.Cost != 0 || entry.TotalTokens != 0 {
			t.Fatalf("a blocked call was billed: cost=%d tokens=%d", entry.Cost, entry.TotalTokens)
		}
		if entry.StatusCode != http.StatusOK {
			t.Fatalf("logged status %d, want 200 — it is what the caller saw", entry.StatusCode)
		}
	}
}

// The reply text is the operator's to choose; the default is only a default.
func TestBlockedReplyIsConfigurable(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"tripwire"}, []string{"这条请求不符合本网关的使用规范。"}),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode != http.StatusOK {
		t.Fatalf("HTTP %d, want 200", r.StatusCode)
	}
	if !strings.Contains(string(body), "不符合本网关的使用规范") {
		t.Fatalf("the configured reply was not used: %s", body)
	}
	if strings.Contains(string(body), "北国风光") {
		t.Fatalf("the default reply was returned instead: %s", body)
	}
}

// An error status has to produce an error, not a success-shaped body carrying
// a 4xx — that combination is what breaks clients.
func TestBlockedStatusIsConfigurable(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockedStatus = http.StatusForbidden
	settings.BlockRules = []relay.BlockRule{
		blockRule("probes", []string{"tripwire"}, []string{"内容不合规"}),
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()

	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("HTTP %d, want the configured 403", r.StatusCode)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("a non-2xx block must be a parseable error: %v (%s)", err, body)
	}
	if parsed.Error.Message != "内容不合规" || parsed.Error.Code != "content_blocked" {
		t.Fatalf("unexpected error body: %s", body)
	}
	if reached.Load() != 0 {
		t.Fatal("a blocked request reached the upstream")
	}
}

// Out-of-range values are refused rather than stored and quietly ignored at
// request time.
func TestBlockedStatusRejectsNonsense(t *testing.T) {
	h := newHarness(t)

	for _, status := range []int{0, 99, 600, -1} {
		settings := h.settings(t)
		settings.BlockedStatus = status
		resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status %d was accepted: HTTP %d", status, resp.StatusCode)
		}
	}
}

// Endpoints that expect something other than prose keep the refusal: a poem in
// place of an embedding vector is a parse error, not a policy message.
func TestBlockedNonChatEndpointStillRefuses(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"text-embedding-3-small"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	r := h.relayRequest(http.MethodPost, "/v1/embeddings", key,
		`{"model":"text-embedding-3-small","input":"tripwire"}`)
	body, _ := io.ReadAll(r.Body)
	r.Body.Close()

	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("embeddings: HTTP %d, want 401", r.StatusCode)
	}
	if strings.Contains(string(body), "北国风光") {
		t.Fatalf("a poem was returned where a vector belongs: %s", body)
	}
}

// Clearing the list has to restore normal service without a restart.
func TestBlockedKeywordsCanBeCleared(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"nope"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	// Both outcomes are now 200, so they are told apart by what came back:
	// the fixed text, or the upstream's own answer.
	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"nope"}]}`)
	blockedBody, _ := io.ReadAll(blocked.Body)
	blocked.Body.Close()
	if !strings.Contains(string(blockedBody), "北国风光") {
		t.Fatalf("expected the keyword to block, got: %s", blockedBody)
	}

	// Blank keywords only — the parse has to treat this as "no keywords"
	// rather than as one empty keyword, which would match everything.
	settings = h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("probes", []string{"", "  "}, nil)}
	resp = h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()

	allowed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"nope"}]}`)
	allowedBody, _ := io.ReadAll(allowed.Body)
	allowed.Body.Close()
	if strings.Contains(string(allowedBody), "北国风光") {
		t.Fatalf("clearing the list did not restore service: %s", allowedBody)
	}
	if allowed.StatusCode != http.StatusOK {
		t.Fatalf("clearing the list did not restore service: HTTP %d", allowed.StatusCode)
	}
}

// Each group answers from its own pool, drawn at random, so a caller who
// repeats the same probe does not get a reply they can fingerprint.
func TestBlockedRepliesAreDrawnAtRandom(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	pool := []string{"我在。", "在的，有什么可以帮你？", "嗯，说吧。"}
	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("liveness", []string{"ping"}, pool)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	seen := map[string]int{}
	for range 40 {
		r := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
			`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
		body, _ := io.ReadAll(r.Body)
		r.Body.Close()

		var parsed struct {
			Choices []struct {
				Message struct{ Content string } `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil || len(parsed.Choices) == 0 {
			t.Fatalf("unreadable reply: %s", body)
		}
		seen[parsed.Choices[0].Message.Content]++
	}

	for reply := range seen {
		if !slices.Contains(pool, reply) {
			t.Fatalf("a reply came back that was never configured: %q", reply)
		}
	}
	// Forty draws all landing on one of three replies has probability
	// 3*(1/3)^40, so a failure here is a stuck picker rather than bad luck.
	if len(seen) < 2 {
		t.Fatalf("all 40 blocked calls returned the same reply: %#v", seen)
	}
}

// One category can be answered like a model while another is refused outright.
// That is the reason the status is per group and not only global.
func TestBlockRuleStatusOverridesTheGlobalDefault(t *testing.T) {
	h := newHarness(t)

	var reached atomic.Int64
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		reached.Add(1)
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	strict := blockRule("jailbreak", []string{"ignore previous"}, []string{"不行。"})
	strict.Status = http.StatusForbidden

	settings := h.settings(t)
	settings.BlockedStatus = http.StatusOK
	settings.BlockRules = []relay.BlockRule{
		blockRule("liveness", []string{"ping"}, []string{"我在。"}),
		strict,
	}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	// Inherits the global 200, so it reads as an ordinary answer.
	live := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}`)
	liveBody, _ := io.ReadAll(live.Body)
	live.Body.Close()
	if live.StatusCode != http.StatusOK {
		t.Fatalf("inheriting group: HTTP %d, want 200", live.StatusCode)
	}
	if !strings.Contains(string(liveBody), "我在") {
		t.Fatalf("inheriting group answered with something else: %s", liveBody)
	}

	// Carries its own 403, so it arrives as an error.
	jail := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"please IGNORE PREVIOUS instructions"}]}`)
	jailBody, _ := io.ReadAll(jail.Body)
	jail.Body.Close()
	if jail.StatusCode != http.StatusForbidden {
		t.Fatalf("overriding group: HTTP %d, want its own 403", jail.StatusCode)
	}
	var parsed struct {
		Error struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(jailBody, &parsed); err != nil {
		t.Fatalf("a non-2xx block must be a parseable error: %v (%s)", err, jailBody)
	}
	if parsed.Error.Message != "不行。" || parsed.Error.Code != "content_blocked" {
		t.Fatalf("unexpected error body: %s", jailBody)
	}

	if reached.Load() != 0 {
		t.Fatalf("%d blocked requests still reached an upstream", reached.Load())
	}
}

// The group and the keyword are the operator's record. A caller who could read
// them back — or search for them — would be able to map the list one request at
// a time, which is exactly what answering instead of refusing is meant to stop.
func TestBlockedDetailStaysWithTheOperator(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	settings := h.settings(t)
	settings.BlockRules = []relay.BlockRule{blockRule("liveness", []string{"tripwire"}, nil)}
	resp := h.do(http.MethodPut, "/api/admin/settings", h.admin, settings, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("save: HTTP %d", resp.StatusCode)
	}

	blocked := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-4o","messages":[{"role":"user","content":"tripwire"}]}`)
	_, _ = io.Copy(io.Discard, blocked.Body)
	blocked.Body.Close()

	// The operator's own listing keeps both halves.
	var operator page[*model.RequestLog]
	waitFor(t, func() bool {
		r := h.do(http.MethodGet, "/api/admin/logs?only_error=true", h.admin, nil, &operator)
		r.Body.Close()
		return len(operator.Data) >= 1
	}, waiting("the blocked call to be logged"))
	if !strings.Contains(operator.Data[0].Error, "liveness") ||
		!strings.Contains(operator.Data[0].Error, "tripwire") {
		t.Fatalf("the operator's log lost the detail: %q", operator.Data[0].Error)
	}

	// The caller's own listing keeps neither. The row is still there — hiding
	// the call entirely would be its own signal.
	var mine page[*model.RequestLog]
	r := h.do(http.MethodGet, "/api/logs?only_error=true", h.admin, nil, &mine)
	r.Body.Close()
	if len(mine.Data) == 0 {
		t.Fatal("the caller cannot see their own blocked call at all")
	}
	for _, entry := range mine.Data {
		if strings.Contains(entry.Error, "tripwire") || strings.Contains(entry.Error, "liveness") {
			t.Fatalf("the caller's log disclosed the policy: %q", entry.Error)
		}
	}

	// Nor can they confirm the word by searching for it, which would tell them
	// just as much as reading it.
	var searched page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/logs?keyword=tripwire", h.admin, nil, &searched)
	r.Body.Close()
	if len(searched.Data) != 0 {
		t.Fatalf("searching the keyword returned %d rows, want none", len(searched.Data))
	}

	// The same search still has to work for the operator.
	var operatorSearch page[*model.RequestLog]
	r = h.do(http.MethodGet, "/api/admin/logs?keyword=tripwire", h.admin, nil, &operatorSearch)
	r.Body.Close()
	if len(operatorSearch.Data) == 0 {
		t.Fatal("the operator cannot find the blocked call by its keyword")
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

// openStream connects to an SSE endpoint and returns a channel of decoded log
// events, mirroring what the console's reader does.
func (h *harness) openStream(t *testing.T, path, token string) (<-chan *model.RequestLog, func()) {
	t.Helper()

	req, err := http.NewRequest(http.MethodGet, h.server.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("stream %s: HTTP %d", path, resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		resp.Body.Close()
		t.Fatalf("Content-Type = %q", ct)
	}

	events := make(chan *model.RequestLog, 16)
	go func() {
		defer close(events)
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 0, 64<<10), 1<<20)
		for scanner.Scan() {
			line := scanner.Text()
			payload, found := strings.CutPrefix(line, "data: ")
			if !found {
				continue
			}
			var entry model.RequestLog
			if json.Unmarshal([]byte(payload), &entry) == nil {
				events <- &entry
			}
		}
	}()
	return events, func() { resp.Body.Close() }
}

func TestCacheCreationTokensAreRecordedWithoutChangingCost(t *testing.T) {
	h := newHarness(t)

	// Anthropic-shaped usage: 100 fresh + 20 read from cache + 5 written to it.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []map[string]string{{"type": "text", "text": "ok"}},
			"usage": map[string]int{
				"input_tokens": 100, "output_tokens": 40,
				"cache_read_input_tokens": 20, "cache_creation_input_tokens": 5,
			},
		})
	})
	h.createChannel(channelInput{
		Name: "cache-src", Type: "anthropic", BaseURL: up.URL, APIKey: "k",
		Models: []string{"claude-sonnet-4-5-20250929"}, Groups: []string{"default"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/messages", key,
		`{"model":"claude-sonnet-4-5-20250929","max_tokens":16}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.CacheCreationTokens != 5 {
		t.Fatalf("cache creation = %d, want 5", entry.CacheCreationTokens)
	}
	if entry.CachedTokens != 20 {
		t.Fatalf("cached = %d, want 20", entry.CachedTokens)
	}
	// The write half stays inside the prompt total, which is what billing
	// charges on — breaking it out must not have moved any money.
	if entry.PromptTokens != 125 {
		t.Fatalf("prompt = %d, want 125 (100 fresh + 20 read + 5 written)", entry.PromptTokens)
	}

	// claude-sonnet-4-5: $3/1M in, $15/1M out, $0.30/1M cached.
	// (125-20)*3 + 20*0.30 + 40*15 = 315 + 6 + 600 = 921 micro-USD.
	if entry.Cost != 921 {
		t.Fatalf("cost = %d micro-USD, want 921", entry.Cost)
	}

	logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if logs[0].CacheCreationTokens != 5 {
		t.Fatalf("cache creation did not survive the round trip: %+v", logs[0])
	}
}

func TestReasoningEffortAndClientTypeAreLogged(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "hints", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	req, err := http.NewRequest(http.MethodPost, h.server.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"gpt-4o","reasoning_effort":"high"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Originator", "codex-tui")

	resp, err := h.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "high" {
		t.Fatalf("reasoning effort = %q, want high", entry.ReasoningEffort)
	}
	// The TUI is reported as itself rather than folded into the family, so a
	// report can tell it apart from Codex Desktop.
	if entry.ClientType != "codex-tui" {
		t.Fatalf("client type = %q, want codex-tui", entry.ClientType)
	}

	// The upstream must receive the body unchanged: these labels are read, not
	// injected.
	if body := up.body(); !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("request body was altered: %s", body)
	}
}

// The channel's own vocabulary is applied on the way out: a caller asking for a
// level this upstream has never heard of is rewritten into the one it accepts,
// rather than having the whole request rejected.
func TestChannelRewritesReasoningEffort(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-map", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: map[string]string{"max": "xhigh"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-5","reasoning_effort":"max","temperature":0.7}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	body := up.body()
	if !strings.Contains(body, `"reasoning_effort":"xhigh"`) {
		t.Fatalf("upstream did not receive the mapped level: %s", body)
	}
	if strings.Contains(body, `"max"`) {
		t.Fatalf("the original level was still sent: %s", body)
	}
	// Everything around the rewritten field has to survive untouched, exactly
	// as it does for a model rewrite.
	if !strings.Contains(body, `"temperature":0.7`) {
		t.Fatalf("the rest of the payload was altered: %s", body)
	}

	// The log says what was asked for and what went out, so an operator can see
	// the substitution happened rather than guessing from a bare level.
	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "max → xhigh" {
		t.Fatalf("reasoning effort = %q, want %q", entry.ReasoningEffort, "max → xhigh")
	}
}

// A channel with no rule for the level the caller sent must stay transparent.
func TestChannelWithoutMatchingEffortRuleForwardsVerbatim(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "effort-partial", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: map[string]string{"max": "xhigh"},
	})
	key := h.createKey()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key,
		`{"model":"gpt-5","reasoning_effort":"low"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if body := up.body(); !strings.Contains(body, `"reasoning_effort":"low"`) {
		t.Fatalf("an unmapped level was not forwarded verbatim: %s", body)
	}
	entry := h.waitForLog(t, 1)
	if entry.ReasoningEffort != "low" {
		t.Fatalf("reasoning effort = %q, want low", entry.ReasoningEffort)
	}
}

// The rule survives the round trip through the console API, including the
// case-folding the store applies to the level names.
func TestChannelEffortMappingRoundTrip(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "effort-persist", Type: "openai", BaseURL: "https://up.test", APIKey: "k",
		Models: []string{"gpt-5"}, Groups: []string{"default"},
		ReasoningEffortMapping: map[string]string{"MAX": "xhigh", "  ": "ignored", "medium": "  "},
	})

	saved := h.channel(id)
	if got := saved.ReasoningEffortMapping["max"]; got != "xhigh" {
		t.Fatalf("mapping did not persist folded: %+v", saved.ReasoningEffortMapping)
	}
	// A half-filled row is a line still being typed, not a rule.
	if len(saved.ReasoningEffortMapping) != 1 {
		t.Fatalf("incomplete rules were kept: %+v", saved.ReasoningEffortMapping)
	}
}

func TestLogStreamPushesNewEntries(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "streamed", 3, 2)
	})
	h.createChannel(channelInput{
		Name: "stream-src", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	events, closeStream := h.openStream(t, "/api/logs/stream", h.admin)
	defer closeStream()

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	select {
	case entry := <-events:
		if entry == nil {
			t.Fatal("stream closed before delivering an entry")
		}
		if entry.Model != "gpt-4o" || entry.StatusCode != http.StatusOK {
			t.Fatalf("unexpected entry: %+v", entry)
		}
		// The row must already be durable, otherwise a reload would show less
		// than the live view did.
		if entry.ID == 0 {
			t.Fatalf("entry was published before it was persisted: %+v", entry)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no log event arrived")
	}
}

func TestLogStreamIsScopedToTheCaller(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1, 1)
	})
	h.createChannel(channelInput{
		Name: "scoped", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// A second account listens while the admin generates traffic.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "bystander", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "bystander", Password: "password123"}, &session)

	theirs, closeTheirs := h.openStream(t, "/api/logs/stream", session.Token)
	defer closeTheirs()
	mine, closeMine := h.openStream(t, "/api/logs/stream", h.admin)
	defer closeMine()

	key := h.createKey() // belongs to the admin
	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	select {
	case <-mine:
	case <-time.After(10 * time.Second):
		t.Fatal("the owner never received their own entry")
	}

	select {
	case entry := <-theirs:
		t.Fatalf("another user's entry leaked into the feed: %+v", entry)
	case <-time.After(time.Second):
		// Correct: nothing for them.
	}
}

func TestPromptedChannelTestReturnsTheModelReply(t *testing.T) {
	h := newHarness(t)

	var seenBody atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		seenBody.Store(u.body())
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{"message": map[string]string{"role": "assistant", "content": "这是模型的回答"}},
			},
			"usage": map[string]int{"prompt_tokens": 30, "completion_tokens": 12, "total_tokens": 42},
		})
	})
	id := h.createChannel(channelInput{
		Name: "prompted", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o", "gpt-4o-mini"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"model": "gpt-4o-mini", "prompt_template": "json-output"}, &result)

	if !result.OK {
		t.Fatalf("probe failed: %+v", result)
	}
	if result.Reply != "这是模型的回答" {
		t.Fatalf("reply = %q", result.Reply)
	}
	if result.Model != "gpt-4o-mini" {
		t.Fatalf("the selected model was ignored: %q", result.Model)
	}
	if result.Usage.TotalTokens != 42 {
		t.Fatalf("usage not reported: %+v", result.Usage)
	}
	if result.Prompt == "" {
		t.Fatal("the resolved prompt should come back for display")
	}

	// The template text must actually reach the upstream, and the budget has to
	// leave room for an answer.
	body, _ := seenBody.Load().(string)
	if !strings.Contains(body, "gpt-4o-mini") || !strings.Contains(body, "next_step") {
		t.Fatalf("prompt not forwarded: %s", body)
	}
	if !strings.Contains(body, `"max_tokens":1024`) {
		t.Fatalf("prompted probe did not raise the token budget: %s", body)
	}
}

func TestChannelTestCanChooseEachRequestProtocol(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/responses":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"output": []map[string]any{{"content": []map[string]string{{
					"type": "output_text", "text": "responses-ok",
				}}}},
			})
		case "/v1/messages":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content": []map[string]string{{"type": "text", "text": "messages-ok"}},
			})
		case "/v1/chat/completions":
			chatResponse(w, "chat-ok", 1, 1)
		default:
			http.NotFound(w, r)
		}
	})
	id := h.createChannel(channelInput{
		Name: "protocol-probe", BaseURL: up.URL, APIKey: "upstream-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	tests := []struct {
		protocol, endpoint, reply, auth, xAPIKey string
	}{
		{protocol: relay.TestProtocolResponses, endpoint: "/v1/responses", reply: "responses-ok", auth: "Bearer upstream-key"},
		{protocol: relay.TestProtocolChatCompletions, endpoint: "/v1/chat/completions", reply: "chat-ok", auth: "Bearer upstream-key"},
		{protocol: relay.TestProtocolMessages, endpoint: "/v1/messages", reply: "messages-ok", xAPIKey: "upstream-key"},
	}
	for _, tc := range tests {
		t.Run(tc.protocol, func(t *testing.T) {
			var result relay.TestResult
			resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
				map[string]any{"model": "gpt-4o", "protocol": tc.protocol, "prompt": "ping"}, &result)
			resp.Body.Close()
			if resp.StatusCode != http.StatusOK || !result.OK {
				t.Fatalf("HTTP %d, result %+v", resp.StatusCode, result)
			}
			if result.Endpoint != tc.endpoint || result.Reply != tc.reply {
				t.Fatalf("endpoint/reply = %q/%q, want %q/%q", result.Endpoint, result.Reply, tc.endpoint, tc.reply)
			}
			hdrs := up.headers()
			if got := up.auth(); got != tc.auth {
				t.Errorf("Authorization = %q, want %q", got, tc.auth)
			}
			if got := hdrs.Get("X-Api-Key"); got != tc.xAPIKey {
				t.Errorf("X-Api-Key = %q, want %q", got, tc.xAPIKey)
			}
		})
	}
}

func TestPromptedChannelTestFlagsAnEmptyReply(t *testing.T) {
	h := newHarness(t)

	// A gateway that answers 200 with no content is broken in a way a plain
	// status check would call healthy.
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": ""}}},
		})
	})
	id := h.createChannel(channelInput{
		Name: "empty-reply", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var result relay.TestResult
	h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"prompt": "你好"}, &result)

	if result.OK {
		t.Fatalf("an empty reply must not pass: %+v", result)
	}
	if result.Message == "" {
		t.Fatal("an empty reply needs an explanation")
	}
}

func TestChannelTestRejectsAnUnknownTemplate(t *testing.T) {
	h := newHarness(t)

	id := h.createChannel(channelInput{
		Name: "tpl", Type: "openai", BaseURL: "https://example.invalid", APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	resp := h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/test", id), h.admin,
		map[string]any{"prompt_template": "no-such-template"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestPromptTemplatesEndpoint(t *testing.T) {
	h := newHarness(t)

	var listed struct {
		Data []relay.PromptTemplate `json:"data"`
	}
	resp := h.do(http.MethodGet, "/api/admin/prompt-templates", h.admin, nil, &listed)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK || len(listed.Data) != 10 {
		t.Fatalf("HTTP %d with %d templates", resp.StatusCode, len(listed.Data))
	}
	for _, template := range listed.Data {
		if template.ID == "" || template.Name == "" || template.Prompt == "" {
			t.Fatalf("incomplete template in response: %+v", template)
		}
	}
}

func TestQuickImportParsesPastedTextAndPullsModels(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}},
		})
	})

	var preview channelImportPreview
	resp := h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text: fmt.Sprintf("接口地址 %s/v1/chat/completions\nAPI Key: sk-import-test-0123456789", up.URL),
	}, &preview)
	resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("import status = %d", resp.StatusCode)
	}
	if preview.APIKey != "sk-import-test-0123456789" {
		t.Fatalf("api key = %q", preview.APIKey)
	}
	if !strings.HasSuffix(preview.BaseURL, "/v1") {
		t.Fatalf("base url kept the endpoint path: %q", preview.BaseURL)
	}
	if preview.AuthStyle != model.AuthStyleAuto {
		t.Fatalf("auth style = %q", preview.AuthStyle)
	}
	if len(preview.Models) != 2 || preview.ModelError != "" {
		t.Fatalf("models = %v, error = %q", preview.Models, preview.ModelError)
	}
	if preview.Existing != nil {
		t.Fatalf("unexpected existing channel: %+v", preview.Existing)
	}
	// Nothing may be written before the operator saves the reviewed draft.
	if _, total, err := h.store.ListChannels(context.Background(), store.ChannelFilter{Limit: 10}); err != nil || total != 0 {
		t.Fatalf("import created %d channel(s) (err %v)", total, err)
	}
}

func TestQuickImportReportsAnExistingChannelAndAProbeFailure(t *testing.T) {
	h := newHarness(t)

	// A channel named after the host the paste points at.
	id := h.createChannel(channelInput{
		Name: "example.com", Type: "openai", BaseURL: "https://api.example.com",
		APIKey: "k", Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text: "https://api.example.com/v1 sk-existing-channel-0123456789",
	}, &preview)

	if preview.Existing == nil || preview.Existing.ID != id {
		t.Fatalf("existing channel not reported: %+v", preview.Existing)
	}
	// The upstream is unreachable, which must degrade to a message rather than
	// throwing away the address and credential the operator just pasted.
	if preview.ModelError == "" {
		t.Fatal("a failed probe must be reported")
	}
	if preview.BaseURL == "" || preview.APIKey == "" {
		t.Fatalf("a failed probe discarded the draft: %+v", preview)
	}
}

func TestImportPreviewReusesTheStoredKeyWithoutEchoingIt(t *testing.T) {
	h := newHarness(t)

	var seenAuth atomic.Value
	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		seenAuth.Store(r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"data": []map[string]string{{"id": "gpt-4o"}},
		})
	})
	id := h.createChannel(channelInput{
		Name: "stored-key", Type: "openai", BaseURL: up.URL, APIKey: "sk-stored-secret",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	// The edit form leaves the key blank to mean "keep the stored one", so the
	// probe has to reach for it server-side.
	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		ChannelID: id, BaseURL: up.URL,
	}, &preview)

	if len(preview.Models) != 1 || preview.ModelError != "" {
		t.Fatalf("probe failed: models=%v error=%q", preview.Models, preview.ModelError)
	}
	if got, _ := seenAuth.Load().(string); got != "Bearer sk-stored-secret" {
		t.Fatalf("upstream saw %q, want the stored credential", got)
	}
	if preview.APIKey != "" {
		t.Fatalf("the stored credential was echoed back to the browser: %q", preview.APIKey)
	}
}

func TestQuickImportRejectsTextWithoutAnAddress(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/channels/import", h.admin,
		channelImportInput{Text: "请联系管理员开通", SkipModels: true}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
}

func TestQuickImportHonoursExplicitOverrides(t *testing.T) {
	h := newHarness(t)

	var preview channelImportPreview
	h.do(http.MethodPost, "/api/admin/channels/import", h.admin, channelImportInput{
		Text:       "https://api.wrong.test/v1 sk-wrong-key-0123456789",
		BaseURL:    "https://api.right.test/v1/chat/completions",
		APIKey:     "sk-ant-corrected-0123456789",
		AuthStyle:  model.AuthStyleXAPIKey,
		SkipModels: true,
	}, &preview)

	if preview.BaseURL != "https://api.right.test/v1" {
		t.Fatalf("override ignored: %q", preview.BaseURL)
	}
	if preview.APIKey != "sk-ant-corrected-0123456789" {
		t.Fatalf("key override ignored: %q", preview.APIKey)
	}
	if preview.AuthStyle != model.AuthStyleXAPIKey {
		t.Fatalf("auth style override ignored: %q", preview.AuthStyle)
	}
	if preview.SuggestedName != "right.test" {
		t.Fatalf("name = %q", preview.SuggestedName)
	}
}

// ------------------------------------------------------------------ helpers

// waitForLog waits for the asynchronous settlement goroutine to persist logs.
func (h *harness) waitForLog(t *testing.T, want int) *model.RequestLog {
	t.Helper()
	var logs []*model.RequestLog
	h.waitFor(t, fmt.Sprintf("%d request log(s)", want), func() bool {
		var err error
		logs, _, err = h.store.ListLogs(context.Background(), store.LogFilter{Limit: 10})
		return err == nil && len(logs) >= want
	})
	return logs[0]
}

// logByStatus returns the most recent log entry with the given status code.
func (h *harness) logByStatus(t *testing.T, status int) *model.RequestLog {
	t.Helper()
	logs, _, err := h.store.ListLogs(context.Background(), store.LogFilter{Limit: 50})
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range logs {
		if int(entry.StatusCode) == status {
			return entry
		}
	}
	t.Fatalf("no request log with status %d", status)
	return nil
}

func (h *harness) waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}
