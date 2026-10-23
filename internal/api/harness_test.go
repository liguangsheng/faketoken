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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/db"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/probe"
	"github.com/faketoken/faketoken/internal/relay"

	// Aliased: this package's mock server is also called upstream.
	"github.com/faketoken/faketoken/internal/store"
	upstreampool "github.com/faketoken/faketoken/internal/upstream"
)

type harness struct {
	t      *testing.T
	server *httptest.Server
	store  *store.Store
	pool   *pgxpool.Pool
	admin  string // session token
	// feed serves the catalogue the importer pulls. Nil means MODELS_DEV_URL
	// is unset, which is how a deployment with no egress runs.
	feed *fakeFeed
}

// feedModel is one catalogue entry, in USD per 1M tokens.
type feedModel struct {
	input  float64
	output float64
	cached float64
}

// testCatalogue is the price table every harness starts from. The rates are
// fixed rather than pulled, so an assertion like "7500 micro-USD" cannot move
// when models.dev re-prices a model. deepseek-v3 is deliberately absent: the
// unpriced-model tests need a model nobody has priced.
func testCatalogue() map[string]feedModel {
	return map[string]feedModel{
		"gpt-4o":       {input: 2.5, output: 10, cached: 1.25},
		"gpt-4o-mini":  {input: 0.15, output: 0.6, cached: 0.075},
		"gpt-4.1":      {input: 2, output: 8, cached: 0.5},
		"gpt-4.1-mini": {input: 0.4, output: 1.6, cached: 0.1},
		"gpt-5":        {input: 1.25, output: 10, cached: 0.125},
		// Gemini names its model in the URL path rather than the body, so these
		// are easy to miss when grepping the suite for relayed model names.
		"gemini-2.5-flash":       {input: 0.3, output: 2.5, cached: 0.03},
		"gemini-2.5-pro":         {input: 1.25, output: 10, cached: 0.125},
		"claude-sonnet-4-5":      {input: 3, output: 15, cached: 0.3},
		"text-embedding-3-small": {input: 0.02},
	}
}

// repriced copies the catalogue with one input rate moved, which is how a
// models.dev price change reaches the importer.
func repriced(name string, input float64) map[string]feedModel {
	out := testCatalogue()
	entry := out[name]
	entry.input = input
	out[name] = entry
	return out
}

// fakeFeed serves a models.dev-shaped payload. The payload is swappable
// because the importer fetches on every call, so rewriting it is how a test
// moves a price mid-run.
type fakeFeed struct {
	server *httptest.Server
	mu     sync.Mutex
	body   string
}

func newFakeFeed(t *testing.T, body string) *fakeFeed {
	t.Helper()
	f := &fakeFeed{body: body}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, f.body)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func (f *fakeFeed) set(body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.body = body
}

// url is the feed's address, or "" when there is no feed.
func (f *fakeFeed) url() string {
	if f == nil {
		return ""
	}
	return f.server.URL
}

// feedBody renders a catalogue payload holding every model under one provider.
func feedBody(t *testing.T, models map[string]feedModel) string {
	t.Helper()
	type cost struct {
		Input     float64 `json:"input"`
		Output    float64 `json:"output"`
		CacheRead float64 `json:"cache_read"`
	}
	type entry struct {
		ID   string `json:"id"`
		Cost cost   `json:"cost"`
	}
	type provider struct {
		Models map[string]entry `json:"models"`
	}

	entries := make(map[string]entry, len(models))
	for id, rates := range models {
		entries[id] = entry{ID: id, Cost: cost{
			Input: rates.input, Output: rates.output, CacheRead: rates.cached,
		}}
	}
	raw, err := json.Marshal(map[string]provider{"openai": {Models: entries}})
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
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
	return newHarnessWithCatalogue(t, newFakeFeed(t, feedBody(t, testCatalogue())))
}

// newHarnessWithoutCatalogue leaves MODELS_DEV_URL unset, which is how a
// deployment with no egress runs.
func newHarnessWithoutCatalogue(t *testing.T) *harness {
	t.Helper()
	return newHarnessWithCatalogue(t, nil)
}

func newHarnessWithCatalogue(t *testing.T, feed *fakeFeed) *harness {
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
		ModelsDevURL:   feed.url(),
		// Deliberately not the production claim: serving that here would pass
		// even if the handler ignored configuration and echoed a constant.
		ARAClaim: testARAClaim,
	}

	cipher, err := auth.NewCipher(cfg.EncryptionKey)
	if err != nil {
		t.Fatal(err)
	}
	st := store.New(pool, cipher)

	// Seeded directly rather than through the importer: these rates are a
	// fixture, and the import path has its own tests below.
	for name, rates := range testCatalogue() {
		price := model.ModelPrice{
			Model:       name,
			InputPrice:  rates.input,
			OutputPrice: rates.output,
			CachedPrice: rates.cached,
		}
		if err := st.UpsertPrice(ctx, &price); err != nil {
			t.Fatal(err)
		}
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
	importer := billing.NewImporter(st, cfg.ModelsDevURL)
	clients := upstreampool.NewPool()
	rl := relay.New(st, pricer, cfg, clients)
	srv := httptest.NewServer(NewServer(cfg, st, jwt, pricer, rl,
		probe.New(clients, rl.CaptureLimit), importer).Handler())
	t.Cleanup(srv.Close)

	h := &harness{t: t, server: srv, store: st, pool: pool, feed: feed}
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

// channel returns the channel as the API reports it, for reading the window
// state back after the relay's detached bookkeeping has run.
func (h *harness) channel(id int64) model.Channel {
	h.t.Helper()
	var fetched model.Channel
	resp := h.do(http.MethodGet, fmt.Sprintf("/api/admin/channels/%d", id), h.admin, nil, &fetched)
	resp.Body.Close()
	return fetched
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

// storedBodies counts the calls whose full bodies are retained.
func (h *harness) storedBodies(t *testing.T) int {
	t.Helper()
	return h.count(t, `SELECT count(*) FROM request_log_details`)
}

// storedBodyIDs lists the calls whose full bodies are retained, ascending.
func (h *harness) storedBodyIDs(t *testing.T) []int64 {
	t.Helper()
	rows, err := h.pool.Query(context.Background(),
		`SELECT log_id FROM request_log_details ORDER BY log_id`)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		t.Fatal(err)
	}
	return ids
}

// storedChunks counts the distinct body chunks on disk.
func (h *harness) storedChunks(t *testing.T) int {
	t.Helper()
	return h.count(t, `SELECT count(*) FROM body_chunks`)
}

func (h *harness) count(t *testing.T, query string) int {
	t.Helper()
	var n int
	if err := h.pool.QueryRow(context.Background(), query).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// ageChunks moves every chunk past the collector's grace period, so a test
// can collect without waiting it out.
func (h *harness) ageChunks(t *testing.T) {
	t.Helper()
	if _, err := h.pool.Exec(context.Background(),
		`UPDATE body_chunks SET last_used = last_used - interval '1 day'`); err != nil {
		t.Fatal(err)
	}
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

func (h *harness) consoleSettings(t *testing.T) consoleSettings {
	t.Helper()
	var settings consoleSettings
	h.do(http.MethodGet, "/api/settings", h.admin, nil, &settings)
	return settings
}

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
