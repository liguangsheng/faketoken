package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

// redactBlocked replaces the block policy's own note with a generic one.
//
// The stored text names the group that matched and the keyword it matched on,
// which is for the operator. Showing it to the caller would turn their own log
// page into a probe: send a guess, read back which word tripped, repeat.
// forOwner trims a row to what the account that made the call is shown. The
// block policy's note is redacted, and the routing internals stay with the
// operator: the upstream model a name was mapped to, the status a channel rule
// rewrote, and the address the call arrived from.
func forOwner(entry *model.RequestLog) {
	if strings.HasPrefix(entry.Error, relay.BlockedLogPrefix) {
		entry.Error = relay.BlockedLogRedacted
	}
	entry.UpstreamModel = ""
	entry.UpstreamStatus = 0
	entry.ClientIP = ""
}

func logFilter(r *http.Request) store.LogFilter {
	offset, limit := pagination(r)
	return store.LogFilter{
		ChannelID: queryInt64(r, "channel_id"),
		TokenID:   queryInt64(r, "token_id"),
		TokenName: r.URL.Query().Get("token_name"),
		Model:     r.URL.Query().Get("model"),
		Username:  r.URL.Query().Get("username"),
		Keyword:   r.URL.Query().Get("keyword"),
		OnlyError: queryBool(r, "only_error"),
		Start:     queryTime(r, "start"),
		End:       queryTime(r, "end"),
		Offset:    offset,
		Limit:     limit,
	}
}

func (s *Server) handleListLogs(w http.ResponseWriter, r *http.Request) {
	f := logFilter(r)
	// A regular user only ever sees their own traffic.
	f.UserID = userFrom(r.Context()).ID
	f.Username = ""
	// Withheld from the search as well as from the response: matching on the
	// text would confirm it just as well as reading it.
	f.HideErrorPrefix = relay.BlockedLogPrefix
	f.HideOperatorColumns = true

	logs, total, err := s.store.ListLogs(r.Context(), f)
	if err != nil {
		failErr(w, err)
		return
	}
	for _, entry := range logs {
		forOwner(entry)
	}
	ok(w, page[*model.RequestLog]{Data: logs, Total: total})
}

func (s *Server) handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	f := logFilter(r)
	f.UserID = queryInt64(r, "user_id")

	logs, total, err := s.store.ListLogs(r.Context(), f)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[*model.RequestLog]{Data: logs, Total: total})
}

// handleAdminLogDetail returns the full request and response for one call.
//
// Its own endpoint rather than a field on the listing: the bodies run to
// megabytes and the list is fetched constantly, so they travel only when
// somebody opens a specific call.
func (s *Server) handleAdminLogDetail(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "log")
	if !valid {
		return
	}

	detail, err := s.store.GetLogDetail(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		// Distinguished from a plain 404 so the console can say why: the call
		// is real, its bodies have simply rolled out of the retained window.
		fail(w, http.StatusGone, "该请求的完整正文已超出保留范围")
		return
	}
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, detail)
}

// handleCancelInflight ends a call that is still running.
//
// Keyed by the live key rather than a log id because there is no row yet: the
// call being stopped is precisely the one that has not settled. The key is the
// same handle the console draws its in-flight row against, so the row an
// operator is looking at and the goroutine this aborts cannot drift apart.
func (s *Server) handleCancelInflight(w http.ResponseWriter, r *http.Request) {
	key := strings.TrimSpace(r.PathValue("key"))
	if key == "" {
		fail(w, http.StatusBadRequest, "missing the in-flight key")
		return
	}

	if !s.relay.CancelLive(key) {
		// Lost the race with the call finishing on its own. Reported as a 404
		// so the console can say "已经结束了" instead of "取消失败", which would
		// read as a system that refused a valid instruction.
		fail(w, http.StatusNotFound, "该调用已经结束")
		return
	}

	// There is no audit log in this system, so the operator's name goes here or
	// nowhere: a 499 row with no explanation is the kind of thing somebody
	// spends an afternoon on months later.
	slog.Warn("an administrator cancelled a running call",
		"live_key", key, "admin", userFrom(r.Context()).Username)
	ok(w, map[string]string{"key": key})
}

func (s *Server) handlePurgeLogs(w http.ResponseWriter, r *http.Request) {
	days := queryInt(r, "days", 30)
	if days < 0 {
		days = 0
	}
	before := time.Now().AddDate(0, 0, -days)
	// The stored bodies hang off request_logs with ON DELETE CASCADE, so this
	// one statement takes them with it.
	deleted, err := s.store.DeleteLogsBefore(r.Context(), before)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"deleted": deleted, "before": before})
}

// ---------------------------------------------------------------- analytics

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	f := statsFilter(r)
	f.UserID = userFrom(r.Context()).ID
	s.writeStats(w, r, f, false)
}

func (s *Server) handleAdminStats(w http.ResponseWriter, r *http.Request) {
	f := statsFilter(r)
	f.UserID = queryInt64(r, "user_id")
	s.writeStats(w, r, f, true)
}

func statsFilter(r *http.Request) store.LogFilter {
	f := store.LogFilter{
		Start: queryTime(r, "start"),
		End:   queryTime(r, "end"),
	}
	if f.Start == nil {
		start := time.Now().AddDate(0, 0, -queryInt(r, "days", 7))
		f.Start = &start
	}
	return f
}

func (s *Server) writeStats(w http.ResponseWriter, r *http.Request, f store.LogFilter, admin bool) {
	ctx := r.Context()

	summary, err := s.store.Summary(ctx, f)
	if err != nil {
		failErr(w, err)
		return
	}
	series, err := s.store.TimeSeries(ctx, f, r.URL.Query().Get("interval"))
	if err != nil {
		failErr(w, err)
		return
	}
	// The operator ranks the model a call really went out as; an account sees
	// only the names it asked for (see forOwner). A call refused before any
	// channel has no upstream model and drops out, as from the channel ranking.
	modelColumn := "model"
	if admin {
		modelColumn = "upstream_model"
	}
	byModel, err := s.store.TopBy(ctx, f, modelColumn, 10)
	if err != nil {
		failErr(w, err)
		return
	}

	payload := map[string]any{
		"summary":  summary,
		"series":   series,
		"by_model": byModel,
	}
	if admin {
		if byChannel, err := s.store.TopBy(ctx, f, "channel_name", 10); err == nil {
			payload["by_channel"] = byChannel
		}
		if byUser, err := s.store.TopBy(ctx, f, "username", 10); err == nil {
			payload["by_user"] = byUser
		}
		if users, err := s.store.CountUsers(ctx); err == nil {
			payload["user_count"] = users
		}
		if _, channels, err := s.store.ListChannels(ctx, store.ChannelFilter{Limit: 1}); err == nil {
			payload["channel_count"] = channels
		}
	}
	ok(w, payload)
}
