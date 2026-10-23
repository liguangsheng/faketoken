package api

import (
	"context"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

type ctxKey int

const userKey ctxKey = iota

func userFrom(ctx context.Context) *model.User {
	u, _ := ctx.Value(userKey).(*model.User)
	return u
}

// requireAuth validates the console session token and loads the caller.
func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if raw == "" {
			fail(w, http.StatusUnauthorized, "sign in required")
			return
		}
		claims, err := s.jwt.Parse(raw)
		if err != nil {
			fail(w, http.StatusUnauthorized, "session expired, please sign in again")
			return
		}
		user, err := s.store.GetUser(r.Context(), claims.UserID)
		if err != nil {
			fail(w, http.StatusUnauthorized, "account no longer exists")
			return
		}
		// The password changed after this token was issued: whoever holds it
		// has not proved they know the new one.
		if claims.Version != user.TokenVersion {
			fail(w, http.StatusUnauthorized, "session expired, please sign in again")
			return
		}
		if user.Status != model.StatusEnabled {
			fail(w, http.StatusForbidden, "this account is disabled")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), userKey, user)))
	}
}

// requireAdmin additionally enforces the administrator role.
func (s *Server) requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return s.requireAuth(func(w http.ResponseWriter, r *http.Request) {
		if u := userFrom(r.Context()); u == nil || !u.IsAdmin() {
			fail(w, http.StatusForbidden, "administrator privileges required")
			return
		}
		next(w, r)
	})
}

// recoverPanic keeps one bad request from taking the process down.
func recoverPanic(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic recovered", "path", r.URL.Path, "panic", rec,
					"stack", string(debug.Stack()))
				fail(w, http.StatusInternalServerError, "internal server error")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/v1") {
			slog.Info("http",
				"method", r.Method, "path", r.URL.Path,
				"status", rec.status, "duration", time.Since(start).Round(time.Millisecond))
		}
	})
}

// securityHeaders limits what a browser may do with the console's responses:
// which scripts run, whether a page may frame it, whether a type may be
// sniffed. The relay surface is left alone, because its responses are the
// upstream's and pass through as they came.
func securityHeaders(policy string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !isRelayPath(r.URL.Path) {
			h := w.Header()
			h.Set("Content-Security-Policy", policy)
			h.Set("X-Content-Type-Options", "nosniff")
			h.Set("X-Frame-Options", "DENY")
			h.Set("Referrer-Policy", "same-origin")
		}
		next.ServeHTTP(w, r)
	})
}

// isRelayPath reports whether a path belongs to the relay rather than the
// console. Kept in step with relay.Register.
func isRelayPath(path string) bool {
	for _, prefix := range []string{"/v1/", "/v1beta/", "/v1alpha/", "/dashboard/billing/"} {
		if strings.HasPrefix(path, prefix) {
			return true
		}
	}
	return false
}

// withCORS lets the Vite dev server (and third-party SDKs hitting /v1) talk to
// the API from another origin.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			reqHeaders := r.Header.Get("Access-Control-Request-Headers")
			if reqHeaders == "" {
				reqHeaders = "Authorization, Content-Type, X-Api-Key, X-Session-ID, Anthropic-Version"
			}
			w.Header().Set("Access-Control-Allow-Headers", reqHeaders)
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
