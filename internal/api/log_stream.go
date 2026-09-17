package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/logstream"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
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
	tokenName string
	model     string
	username  string
	keyword   string
	onlyError bool
	// redact strips the block policy's note, exactly as the list endpoint
	// does. Set for a caller's own feed, clear for an administrator's.
	redact bool
	// live carries calls that have not finished yet. Only the administrator's
	// global view draws them: on a single account's page the placeholder would
	// flicker past on nearly every row without telling anyone anything, while
	// on the global board "what is running right now" is the question being
	// asked.
	live bool
}

func (f streamFilter) matches(entry *model.RequestLog, blocked bool) bool {
	switch {
	case f.userID > 0 && entry.UserID != f.userID:
		return false
	case f.channelID > 0 && entry.ChannelID != f.channelID:
		return false
	case f.tokenName != "" && !strings.EqualFold(entry.TokenName, f.tokenName):
		return false
	case f.model != "" && entry.Model != f.model:
		return false
	case f.username != "" && !strings.EqualFold(entry.Username, f.username):
		return false
	case f.onlyError && entry.StatusCode < 400 && entry.Error == "":
		return false
	case f.keyword != "" && !matchesKeyword(entry, f.keyword, blocked):
		return false
	}
	return true
}

// matchesKeyword mirrors the SQL in store.LogFilter over the same columns, so
// a live entry is appended exactly when a reload would have listed it —
// including the withheld error text, which store.LogFilter.HideErrorPrefix
// excludes from the same search.
func matchesKeyword(entry *model.RequestLog, keyword string, blockedFromCaller bool) bool {
	if strconv.FormatInt(entry.ID, 10) == keyword {
		return true
	}
	needle := strings.ToLower(keyword)
	fields := []string{
		entry.Username, entry.TokenName, entry.Model, entry.UpstreamModel,
		entry.ChannelName, entry.Endpoint, entry.ClientIP,
	}
	if !blockedFromCaller {
		fields = append(fields, entry.Error)
	}
	for _, field := range fields {
		if strings.Contains(strings.ToLower(field), needle) {
			return true
		}
	}
	return false
}

func streamFilterFrom(r *http.Request) streamFilter {
	return streamFilter{
		channelID: queryInt64(r, "channel_id"),
		tokenName: r.URL.Query().Get("token_name"),
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
	filter.redact = true
	s.streamLogs(w, r, filter)
}

// handleAdminStreamLogs pushes every user's new entries, running ones included.
func (s *Server) handleAdminStreamLogs(w http.ResponseWriter, r *http.Request) {
	filter := streamFilterFrom(r)
	filter.userID = queryInt64(r, "user_id")
	filter.live = true
	s.streamLogs(w, r, filter)
}

// feedEvent is the wire form of one event.
//
// The key is what lets a console replace the placeholder it drew when the call
// started with the row that actually settled, instead of listing the same
// request twice.
type feedEvent struct {
	Key   string            `json:"key,omitempty"`
	Entry *model.RequestLog `json:"entry"`
}

// writeEvent frames one SSE event. An unserialisable payload is skipped rather
// than reported: the feed is a convenience, and killing it over one bad row
// would cost the console every row after it.
func writeEvent(w io.Writer, name string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", name, data)
	return err
}

// liveSnapshot renders every running call this feed should be showing.
//
// It is sent whole rather than as a set of keys, which makes it authoritative
// in both directions: a console adopts it as its complete live set, so a start
// that never arrived is recovered just as an end that never arrived is. That
// covers the two ways a placeholder can go wrong — a feed too slow to keep up
// dropped one of its events, or the console stopped drawing them for a while
// (reading page four) and came back.
//
// Filtering it is safe, and it has to be filtered or an unrelated call would
// appear every heartbeat: a running call's fields only ever gain values, so one
// that matched when it was announced still matches now. Nothing a console holds
// can be withheld by this filter.
func (s *Server) liveSnapshot(filter streamFilter) map[string]any {
	events := s.stream.Snapshot()
	calls := make([]feedEvent, 0, len(events))
	for _, event := range events {
		if !filter.matches(event.Entry, false) {
			continue
		}
		calls = append(calls, feedEvent{Key: event.Key, Entry: event.Entry})
	}
	return map[string]any{"calls": calls}
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

	// Sent before the feed is read, and only after Subscribe: a call that starts
	// in between is queued on the subscription and simply arrives twice, which an
	// upsert on the key absorbs. Taking the snapshot first instead would lose
	// exactly those calls.
	//
	// Without this, a request that began before the tab was opened stays
	// invisible for as long as it runs — and the long ones are the point.
	if filter.live {
		if err := writeEvent(w, "inflight_sync", s.liveSnapshot(filter)); err != nil {
			return
		}
	}
	_ = rc.Flush()

	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return

		case event, open := <-sub.Events:
			if !open {
				return
			}
			entry := event.Entry
			if entry == nil {
				continue
			}
			if event.State == logstream.StateLive && !filter.live {
				continue
			}
			// The broker hands every subscriber the same pointer, so the copy
			// has to happen before anything is rewritten on it: redacting in
			// place would blank the text in an administrator's feed too.
			blocked := filter.redact && strings.HasPrefix(entry.Error, relay.BlockedLogPrefix)
			if !filter.matches(entry, blocked) {
				// A placeholder already drawn for this call is left to the next
				// reconciliation rather than chased here: the filters a running
				// row can newly fail are the ones it could not have matched
				// while it was still running anyway.
				continue
			}
			if blocked {
				visible := *entry
				visible.Error = relay.BlockedLogRedacted
				entry = &visible
			}
			name := "log"
			if event.State == logstream.StateLive {
				name = "inflight"
			}
			if err := writeEvent(w, name, feedEvent{Key: event.Key, Entry: entry}); err != nil {
				return
			}
			_ = rc.Flush()

		case <-ticker.C:
			// A comment doubles as the keepalive and as the channel for
			// reporting events this consumer was too slow to receive.
			if _, err := fmt.Fprintf(w, ": ping %d\n\n", sub.Dropped()); err != nil {
				return
			}
			if filter.live {
				// Re-stating the whole set on every heartbeat is what keeps a row
				// from spinning forever after the event that would have retired
				// it was dropped on a slow feed — and what refills the view for a
				// console that was not drawing these rows a moment ago.
				if err := writeEvent(w, "inflight_sync", s.liveSnapshot(filter)); err != nil {
					return
				}
			}
			_ = rc.Flush()
		}
	}
}
