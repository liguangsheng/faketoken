package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/config"
)

// The console ships its sources under names that never change, so every one
// of them has to be revalidated: a browser allowed to keep any of them would
// run yesterday's JavaScript against today's HTML after a deploy, with nothing
// on screen to say so. index.html, a module, a static file and a client-side
// route that falls back to the index all get the same answer.
func TestConsoleFilesAreAlwaysRevalidated(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{"/", "/index.html", "/js/main.js", "/favicon.svg", "/admin/settings"} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if got := resp.Header.Get("Cache-Control"); got != "no-cache" {
			t.Fatalf("%s served with Cache-Control %q, want no-cache", path, got)
		}
	}
}

// A client-side route exists in the router, not on disk, so a refresh on one
// has to be answered with index.html for the app to boot and take over. A
// file that does exist is served as itself, and an unrouted /api path is a
// missing endpoint rather than a page — answering it with HTML would tell a
// probe the endpoint works and hand a client HTML where it expects JSON.
func TestConsoleFallsBackToIndexOnlyForRoutes(t *testing.T) {
	h := newHarness(t)

	for _, probe := range []struct {
		path   string
		status int
		want   string
	}{
		{"/", http.StatusOK, "test console"},
		{"/profile", http.StatusOK, "test console"},
		{"/admin/logs", http.StatusOK, "test console"},
		{"/favicon.svg", http.StatusOK, "<svg"},
		{"/api/does-not-exist", http.StatusNotFound, "endpoint not found"},
	} {
		resp, err := http.Get(h.server.URL + probe.path)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != probe.status {
			t.Fatalf("%s answered %d, want %d", probe.path, resp.StatusCode, probe.status)
		}
		if !strings.Contains(string(body), probe.want) {
			t.Fatalf("%s served %q, want it to contain %q", probe.path, body, probe.want)
		}
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
