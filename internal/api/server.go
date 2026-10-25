package api

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/logstream"
	"github.com/faketoken/faketoken/internal/probe"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

type Server struct {
	cfg    *config.Config
	store  *store.Store
	jwt    *auth.JWTManager
	pricer *billing.Pricer
	relay  *relay.Relay
	// prober is the console's side of an upstream: model pulls, test
	// requests, balance reads. Separate from the relay so what the operator
	// does by hand never shares code with what a client request goes through.
	prober   *probe.Prober
	stream   *logstream.Broker
	importer *billing.Importer
	// guard locks out password guessing on login, signup and password change.
	guard *attemptGuard
}

func NewServer(cfg *config.Config, st *store.Store, jwt *auth.JWTManager,
	pricer *billing.Pricer, rl *relay.Relay, prober *probe.Prober, importer *billing.Importer) *Server {
	s := &Server{cfg: cfg, store: st, jwt: jwt, pricer: pricer, relay: rl,
		prober: prober, stream: logstream.New(), importer: importer, guard: newAttemptGuard()}
	// The relay produces the events this server hands out.
	rl.SetLogStream(s.stream)
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// ---- relay (OpenAI / Anthropic / Gemini compatible surface)
	s.relay.Register(mux)

	// ---- public
	mux.HandleFunc("GET /api/status", s.handleStatus)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/auth/register", s.handleRegister)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		respond(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /.well-known/ara-claim.txt", s.handleARAClaim)

	// ---- authenticated user surface
	mux.HandleFunc("GET /api/version", s.requireAuth(s.handleVersion))
	mux.HandleFunc("GET /api/me", s.requireAuth(s.handleMe))
	mux.HandleFunc("PUT /api/me", s.requireAuth(s.handleUpdateMe))
	mux.HandleFunc("PUT /api/me/password", s.requireAuth(s.handleChangePassword))
	mux.HandleFunc("GET /api/me/models", s.requireAuth(s.handleMyModels))
	mux.HandleFunc("GET /api/me/plaza", s.requireAuth(s.handleModelPlaza))
	mux.HandleFunc("GET /api/me/groups", s.requireAuth(s.handleMyGroups))

	mux.HandleFunc("GET /api/tokens", s.requireAuth(s.handleListTokens))
	mux.HandleFunc("POST /api/tokens", s.requireAuth(s.handleCreateToken))
	mux.HandleFunc("GET /api/tokens/{id}/key", s.requireAuth(s.handleRevealToken))
	mux.HandleFunc("PUT /api/tokens/{id}", s.requireAuth(s.handleUpdateToken))
	mux.HandleFunc("DELETE /api/tokens/{id}", s.requireAuth(s.handleDeleteToken))

	// Readable by everyone signed in, writable only by an administrator: a
	// regular account renders the same tables and needs the same default.
	mux.HandleFunc("GET /api/settings", s.requireAuth(s.handleGetSettings))

	mux.HandleFunc("POST /api/redeem", s.requireAuth(s.handleRedeem))

	mux.HandleFunc("GET /api/logs", s.requireAuth(s.handleListLogs))
	mux.HandleFunc("GET /api/logs/stream", s.requireAuth(s.handleStreamLogs))
	mux.HandleFunc("GET /api/stats", s.requireAuth(s.handleStats))
	mux.HandleFunc("GET /api/stats/heatmap", s.requireAuth(s.handleUsageHeatmap))

	// ---- administrator surface
	mux.HandleFunc("GET /api/admin/users", s.requireAdmin(s.handleListUsers))
	mux.HandleFunc("POST /api/admin/users", s.requireAdmin(s.handleCreateUser))
	mux.HandleFunc("PUT /api/admin/users/{id}", s.requireAdmin(s.handleUpdateUser))
	mux.HandleFunc("DELETE /api/admin/users/{id}", s.requireAdmin(s.handleDeleteUser))
	mux.HandleFunc("POST /api/admin/users/{id}/quota", s.requireAdmin(s.handleGrantQuota))
	mux.HandleFunc("PUT /api/admin/users/{id}/password", s.requireAdmin(s.handleResetPassword))

	mux.HandleFunc("GET /api/admin/channels", s.requireAdmin(s.handleListChannels))
	mux.HandleFunc("GET /api/admin/channels/health", s.requireAdmin(s.handleChannelHealth))
	mux.HandleFunc("POST /api/admin/channels", s.requireAdmin(s.handleCreateChannel))
	mux.HandleFunc("GET /api/admin/channels/{id}", s.requireAdmin(s.handleGetChannel))
	mux.HandleFunc("PUT /api/admin/channels/{id}", s.requireAdmin(s.handleUpdateChannel))
	mux.HandleFunc("DELETE /api/admin/channels/{id}", s.requireAdmin(s.handleDeleteChannel))
	mux.HandleFunc("PUT /api/admin/channels/{id}/status", s.requireAdmin(s.handleChannelStatus))
	// Its own endpoint rather than a field on the update, for the same reason
	// status has one: archiving also disables, and the listing it is invoked
	// from holds only a masked credential.
	mux.HandleFunc("PUT /api/admin/channels/{id}/archive", s.requireAdmin(s.handleChannelArchive))
	mux.HandleFunc("PUT /api/admin/channels/{id}/routing", s.requireAdmin(s.handleChannelRouting))
	mux.HandleFunc("POST /api/admin/channels/{id}/user-agent/clear", s.requireAdmin(s.handleClearChannelUserAgent))
	mux.HandleFunc("POST /api/admin/channels/{id}/test", s.requireAdmin(s.handleTestChannel))
	// Returns the upstream key in the clear, so it stays off the listing and
	// behind its own request.
	mux.HandleFunc("GET /api/admin/channels/{id}/credential",
		s.requireAdmin(s.handleChannelCredential))
	mux.HandleFunc("GET /api/admin/prompt-templates", s.requireAdmin(s.handlePromptTemplates))
	mux.HandleFunc("POST /api/admin/channels/{id}/fetch-models", s.requireAdmin(s.handleFetchModels))
	mux.HandleFunc("GET /api/admin/channels/{id}/models", s.requireAdmin(s.handleChannelModels))
	mux.HandleFunc("PUT /api/admin/channels/{id}/models", s.requireAdmin(s.handleSetChannelModels))
	mux.HandleFunc("POST /api/admin/channels/{id}/clone", s.requireAdmin(s.handleCloneChannel))
	mux.HandleFunc("POST /api/admin/channels/{id}/balance", s.requireAdmin(s.handleChannelBalance))
	mux.HandleFunc("POST /api/admin/channels/{id}/balance/sub2api",
		s.requireAdmin(s.handleChannelSub2APIBalance))
	mux.HandleFunc("POST /api/admin/channels/rebuild", s.requireAdmin(s.handleRebuildAbilities))
	mux.HandleFunc("POST /api/admin/channels/import", s.requireAdmin(s.handleImportChannel))
	mux.HandleFunc("POST /api/admin/channels/batch/status", s.requireAdmin(s.handleBatchChannelStatus))
	mux.HandleFunc("POST /api/admin/channels/batch/delete", s.requireAdmin(s.handleBatchDeleteChannels))
	mux.HandleFunc("POST /api/admin/channels/batch/test", s.requireAdmin(s.handleBatchTestChannels))

	mux.HandleFunc("GET /api/admin/groups", s.requireAdmin(s.handleListGroups))
	mux.HandleFunc("POST /api/admin/groups", s.requireAdmin(s.handleUpsertGroup))
	mux.HandleFunc("DELETE /api/admin/groups/{name}", s.requireAdmin(s.handleDeleteGroup))

	mux.HandleFunc("GET /api/admin/prices", s.requireAdmin(s.handleListPrices))
	mux.HandleFunc("POST /api/admin/prices", s.requireAdmin(s.handleUpsertPrice))
	mux.HandleFunc("POST /api/admin/prices/import", s.requireAdmin(s.handleImportPrices))
	mux.HandleFunc("GET /api/admin/prices/unpriced", s.requireAdmin(s.handleUnpricedModels))
	mux.HandleFunc("DELETE /api/admin/prices/{model}", s.requireAdmin(s.handleDeletePrice))

	mux.HandleFunc("PUT /api/admin/settings", s.requireAdmin(s.handleUpdateSettings))

	mux.HandleFunc("GET /api/admin/redemptions", s.requireAdmin(s.handleListRedemptions))
	mux.HandleFunc("POST /api/admin/redemptions", s.requireAdmin(s.handleCreateRedemptions))
	mux.HandleFunc("PUT /api/admin/redemptions/{id}/status", s.requireAdmin(s.handleRedemptionStatus))
	mux.HandleFunc("POST /api/admin/redemptions/delete", s.requireAdmin(s.handleDeleteRedemptions))

	mux.HandleFunc("GET /api/admin/invites", s.requireAdmin(s.handleListInviteCodes))
	mux.HandleFunc("POST /api/admin/invites", s.requireAdmin(s.handleCreateInviteCodes))
	mux.HandleFunc("PUT /api/admin/invites/{id}/status", s.requireAdmin(s.handleInviteStatus))
	mux.HandleFunc("POST /api/admin/invites/delete", s.requireAdmin(s.handleDeleteInviteCodes))

	mux.HandleFunc("GET /api/admin/billing/settings", s.requireAdmin(s.handleGetBillingSettings))
	mux.HandleFunc("PUT /api/admin/billing/settings", s.requireAdmin(s.handleUpdateBillingSettings))

	mux.HandleFunc("GET /api/admin/logs", s.requireAdmin(s.handleAdminLogs))
	mux.HandleFunc("GET /api/admin/logs/stream", s.requireAdmin(s.handleAdminStreamLogs))
	// Carries the full request and reply verbatim, which is an operator
	// diagnostic rather than something to hand back to the account that sent
	// it, so it stays on the administrator surface.
	mux.HandleFunc("GET /api/admin/logs/{id}/detail", s.requireAdmin(s.handleAdminLogDetail))
	// Keyed by the live key, not a log id: the call being stopped is the one
	// that has no row yet.
	mux.HandleFunc("POST /api/admin/logs/inflight/{key}/cancel", s.requireAdmin(s.handleCancelInflight))
	mux.HandleFunc("DELETE /api/admin/logs", s.requireAdmin(s.handlePurgeLogs))
	mux.HandleFunc("GET /api/admin/stats", s.requireAdmin(s.handleAdminStats))
	mux.HandleFunc("GET /api/admin/stats/heatmap", s.requireAdmin(s.handleAdminUsageHeatmap))

	// The test page's way past a gateway that refuses the browser's CORS
	// preflight; see handlePlaygroundRelay for why it is administrator-only.
	mux.HandleFunc("POST /api/admin/playground/relay", s.requireAdmin(s.handlePlaygroundRelay))

	// ---- single page app
	mux.Handle("/", s.spaHandler())

	return recoverPanic(requestLogger(withCORS(securityHeaders(consolePolicy(s.cfg.WebDir), mux))))
}

// version names the build: git describe output, set by the build through
// -ldflags "-X github.com/faketoken/faketoken/internal/api.version=...".
// "-dirty" marks a build from a working tree with uncommitted changes.
var version = "dev"

// handleStatus is the only endpoint an anonymous visitor can reach, so it says
// the bare minimum: whether the login page should offer a register tab. Build
// details and anything else that identifies the deployment stay behind a
// session.
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	open, openErr := s.allowRegister(r.Context())
	invite, inviteErr := s.requireInviteCode(r.Context())
	ok(w, map[string]any{
		// An unreadable setting reads as closed, which is what registration
		// itself answers in that case.
		"allow_register": open && openErr == nil && inviteErr == nil,
		// Not a secret: a visitor finds out the moment they try to register,
		// and telling the form up front avoids a pointless failed attempt.
		// The codes themselves stay behind the administrator surface.
		"require_invite_code": invite,
	})
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"version": version})
}

// inlineScript matches a script element and captures its attributes and body.
var inlineScript = regexp.MustCompile(`(?is)<script([^>]*)>(.*?)</script>`)

// consolePolicy builds the console's Content-Security-Policy. Scripts are what
// an injected payload needs, and the session token sits in localStorage within
// their reach, so they are the part locked down: this origin, plus the inline
// scripts index.html ships, allowed by hash. Read from the built file at start,
// so editing the theme script needs no matching edit here. Styles, images and
// connections stay open: antd injects styles at runtime, and the playgrounds
// show and fetch whatever an upstream points at.
func consolePolicy(webDir string) string {
	sources := []string{"'self'"}
	if html, err := os.ReadFile(filepath.Join(webDir, "index.html")); err == nil {
		for _, match := range inlineScript.FindAllSubmatch(html, -1) {
			if bytes.Contains(bytes.ToLower(match[1]), []byte("src=")) {
				continue
			}
			sum := sha256.Sum256(match[2])
			sources = append(sources, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
		}
	}
	return "script-src " + strings.Join(sources, " ") +
		"; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
}

// spaHandler serves the built React console and falls back to index.html so
// client-side routes survive a page refresh.
func (s *Server) spaHandler() http.Handler {
	dir := s.cfg.WebDir
	if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			respond(w, http.StatusNotFound, map[string]string{
				"message": "web console not built; run `make web` or set WEB_DIR",
			})
		})
	}

	root := os.DirFS(dir)
	fileServer := http.FileServerFS(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// An unrouted /api path is a missing endpoint, not a console route.
		// Serving index.html here would answer 200 with HTML for a call that
		// does not exist — which reads as "the endpoint still works" to
		// anyone probing, and hands clients HTML where they expect JSON.
		if strings.HasPrefix(r.URL.Path, "/api/") {
			respond(w, http.StatusNotFound, map[string]string{"message": "endpoint not found"})
			return
		}

		clean := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
		if clean == "" || clean == "." {
			clean = "index.html"
		}
		// index.html is the one file whose name never changes, and it is what
		// names the hashed bundles. Letting a browser cache it without
		// revalidating pins that browser to an old build no matter how many
		// times the server is redeployed — the console keeps loading the
		// previous JavaScript until someone force-reloads by hand.
		//
		// no-cache does not mean "do not store": the copy is kept and
		// revalidated, so an unchanged file still costs one 304.
		if _, err := fs.Stat(root, clean); err != nil || clean == "index.html" {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFileFS(w, r, root, "index.html")
			return
		}
		// Safe to cache forever: the build puts a content hash in the name, so
		// a changed file is a different URL.
		if strings.HasPrefix(clean, "assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fileServer.ServeHTTP(w, r)
	})
}
