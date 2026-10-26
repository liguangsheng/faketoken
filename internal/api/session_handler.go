package api

import (
	"errors"
	"net/http"
	"time"

	"github.com/faketoken/faketoken/internal/store"
)

// defaultSessionDays is how far back the session list looks unless asked:
// a conversation idle for a month is history, and the log still has it.
const defaultSessionDays = 30

// handleListSessions lists the conversations active in the last `days`
// (default 30, at most 365), the most recent first.
func (s *Server) handleListSessions(w http.ResponseWriter, r *http.Request) {
	days := min(max(queryInt(r, "days", defaultSessionDays), 1), 365)
	offset, limit := pagination(r)
	since := time.Now().AddDate(0, 0, -days)

	sessions, total, err := s.store.ListSessions(r.Context(), since, offset, limit)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[store.SessionSummary]{Data: sessions, Total: total})
}

// handleGetSession returns one conversation and its lines.
func (s *Server) handleGetSession(w http.ResponseWriter, r *http.Request) {
	session := r.PathValue("session")
	summary, threads, err := s.store.SessionThreads(r.Context(), session)
	if errors.Is(err, store.ErrNotFound) {
		fail(w, http.StatusNotFound, "没有这个会话")
		return
	}
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"session": summary, "threads": threads})
}

// handleThreadCalls returns every call of one line, oldest first: the console
// lays them against the transcript of the line's latest request.
func (s *Server) handleThreadCalls(w http.ResponseWriter, r *http.Request) {
	thread, err := pathID(r, "thread")
	if err != nil || thread < 0 {
		fail(w, http.StatusBadRequest, "invalid thread id")
		return
	}
	calls, err := s.store.ThreadCalls(r.Context(), r.PathValue("session"), thread)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"data": calls})
}
