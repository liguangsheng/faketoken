package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// heartbeatInterval keeps idle connections alive. Reverse proxies commonly
// drop a stream that has been silent for 30–60s, and a quiet gateway is
// exactly when a live log view is left open.
const heartbeatInterval = 20 * time.Second

// streamFilter is the subset of the list filters that can be evaluated against
// a single entry in memory. Time ranges are deliberately absent: a live feed is
// always "now", and honouring an end time would just stop the stream silently.
type streamFilter struct {
	userID    int64 // 0 = every user (administrator view)
	channelID int64
	model     string
	username  string
	keyword   string
	onlyError bool
}

func (f streamFilter) matches(entry *model.RequestLog) bool {
	switch {
	case f.userID > 0 && entry.UserID != f.userID:
		return false
	case f.channelID > 0 && entry.ChannelID != f.channelID:
		return false
	case f.model != "" && entry.Model != f.model:
		return false
	case f.username != "" && !strings.EqualFold(entry.Username, f.username):
		return false
	case f.onlyError && entry.StatusCode < 400 && entry.Error == "":
		return false
	case f.keyword != "" && !matchesKeyword(entry, f.keyword):
		return false
	}
	return true
}

// matchesKeyword mirrors the SQL in store.LogFilter over the same columns, so
// a live entry is appended exactly when a reload would have listed it.
func matchesKeyword(entry *model.RequestLog, keyword string) bool {
	if strconv.FormatInt(entry.ID, 10) == keyword {
		return true
	}
	needle := strings.ToLower(keyword)
	for _, field := range []string{
		entry.Username, entry.TokenName, entry.Model, entry.UpstreamModel,
		entry.ChannelName, entry.Endpoint, entry.ClientIP, entry.Error,
	} {
		if strings.Contains(strings.ToLower(field), needle) {
			return true
		}
	}
	return false
}

func streamFilterFrom(r *http.Request) streamFilter {
	return streamFilter{
		channelID: queryInt64(r, "channel_id"),
		model:     r.URL.Query().Get("model"),
		username:  r.URL.Query().Get("username"),
		keyword:   strings.TrimSpace(r.URL.Query().Get("keyword")),
		onlyError: queryBool(r, "only_error"),
	}
}

// handleStreamLogs pushes the caller's own new entries.
func (s *Server) handleStreamLogs(w http.ResponseWriter, r *http.Request) {
	filter := streamFilterFrom(r)
	// Forced server-side, exactly as the list endpoint does: a regular account
	// must not be able to widen the feed by passing someone else's username.
	filter.userID = userFrom(r.Context()).ID
	filter.username = ""
	s.streamLogs(w, r, filter)
}

// handleAdminStreamLogs pushes every user's new entries.
func (s *Server) handleAdminStreamLogs(w http.ResponseWriter, r *http.Request) {
	filter := streamFilterFrom(r)
	filter.userID = queryInt64(r, "user_id")
	s.streamLogs(w, r, filter)
}

func (s *Server) streamLogs(w http.ResponseWriter, r *http.Request, filter streamFilter) {
	// ResponseController rather than a Flusher assertion: the middleware chain
	// wraps the writer to record status codes, and that wrapper does not carry
	// Flush. The controller follows Unwrap to the real one.
	rc := http.NewResponseController(w)

	sub, ok := s.stream.Subscribe()
	if !ok {
		// Better an honest refusal than accepting a feed we cannot serve; the
		// console falls back to polling.
		fail(w, http.StatusServiceUnavailable, "too many live log connections")
		return
	}
	defer sub.Close()

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// Nginx buffers proxied responses by default, which would hold events back
	// until the buffer fills — i.e. defeat the entire point.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, ": connected\n\n")
	_ = rc.Flush()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return

		case entry, open := <-sub.Events:
			if !open {
				return
			}
			if !filter.matches(entry) {
				continue
			}
			payload, err := json.Marshal(entry)
			if err != nil {
				continue
			}
			if _, err := fmt.Fprintf(w, "event: log\ndata: %s\n\n", payload); err != nil {
				return
			}
			_ = rc.Flush()

		case <-ticker.C:
			// A comment doubles as the keepalive and as the channel for
			// reporting events this consumer was too slow to receive.
			if _, err := fmt.Fprintf(w, ": ping %d\n\n", sub.Dropped()); err != nil {
				return
			}
			_ = rc.Flush()
		}
	}
}
