package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/modelsdev"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

// redactBlocked replaces the block policy's own note with a generic one.
//
// The stored text names the group that matched and the keyword it matched on,
// which is for the operator. Showing it to the caller would turn their own log
// page into a probe: send a guess, read back which word tripped, repeat.
func redactBlocked(logs []*model.RequestLog) {
	for _, entry := range logs {
		if strings.HasPrefix(entry.Error, relay.BlockedLogPrefix) {
			entry.Error = relay.BlockedLogRedacted
		}
	}
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

	logs, total, err := s.store.ListLogs(r.Context(), f)
	if err != nil {
		failErr(w, err)
		return
	}
	redactBlocked(logs)
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
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid log id")
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
	byModel, err := s.store.TopBy(ctx, f, "model", 10)
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

// ------------------------------------------------------------------- prices

func (s *Server) handleListPrices(w http.ResponseWriter, r *http.Request) {
	prices, err := s.store.ListPrices(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{
		"data": prices,
		// Advertised alongside the table so the console can offer the import
		// without a second round trip.
		"catalog": s.importer.Status(r.Context()),
	})
}

// handleImportPrices refreshes the price table from the models.dev catalogue.
// It is deliberately additive by default: an operator's own rates outrank a
// third-party catalogue unless they ask for the overwrite. Three forms:
//
//   - ?dry_run=true: pull the catalogue, report what a write would change.
//   - a JSON body holding the plan a dry run returned: apply exactly that
//     plan, refused with 409 if a newer catalogue was fetched in between.
//   - neither: plan and apply in one step, for callers that skip the preview.
func (s *Server) handleImportPrices(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	overwrite := queryBool(r, "overwrite")
	dryRun := queryBool(r, "dry_run")

	if !s.importer.Enabled() {
		fail(w, http.StatusServiceUnavailable,
			"price catalogue import is disabled; set MODELS_DEV_URL to enable it")
		return
	}

	// A body means "apply this plan", not "plan again": the operator
	// confirmed a specific preview, and re-planning could land something
	// else if the catalogue moved in between.
	var submitted *billing.ImportPlan
	if r.ContentLength != 0 {
		if !decode(w, r, &submitted) {
			return
		}
	}

	var (
		plan *billing.ImportPlan
		err  error
	)
	switch {
	case dryRun:
		plan, err = s.importer.Plan(ctx, overwrite)
	case submitted != nil:
		plan = submitted
		err = s.importer.Apply(ctx, submitted)
	default:
		plan, err = s.importer.Import(ctx, overwrite)
	}
	if err != nil {
		switch {
		case errors.Is(err, billing.ErrStaleFeed):
			fail(w, http.StatusConflict, err.Error())
		case errors.Is(err, modelsdev.ErrUpstream):
			// The catalogue endpoint is the operator's mirror or models.dev;
			// 502 says "the upstream is the problem", not this gateway.
			slog.Warn("price catalogue fetch failed", "error", err)
			fail(w, http.StatusBadGateway, err.Error())
		default:
			failErr(w, err)
		}
		return
	}
	// A dry run changes nothing, so the in-memory table is still correct.
	if !dryRun {
		if err := s.pricer.Reload(ctx); err != nil {
			failErr(w, err)
			return
		}
	}

	ok(w, map[string]any{
		"dry_run":     dryRun,
		"overwrite":   plan.Overwrite,
		"total":       plan.Total,
		"added":       plan.Added,
		"changed":     plan.Changed,
		"kept":        plan.Kept,
		"unchanged":   plan.Unchanged,
		"feed_sha256": plan.FeedSHA256,
	})
}

func (s *Server) handleUpsertPrice(w http.ResponseWriter, r *http.Request) {
	var in model.ModelPrice
	if !decode(w, r, &in) {
		return
	}
	in.Model = strings.TrimSpace(in.Model)
	if in.Model == "" {
		fail(w, http.StatusBadRequest, "the model name is required")
		return
	}
	if in.InputPrice < 0 || in.OutputPrice < 0 || in.CachedPrice < 0 || in.PerRequestPrice < 0 {
		fail(w, http.StatusBadRequest, "prices cannot be negative")
		return
	}
	if err := s.store.UpsertPrice(r.Context(), &in); err != nil {
		failErr(w, err)
		return
	}
	if err := s.pricer.Reload(r.Context()); err != nil {
		failErr(w, err)
		return
	}
	ok(w, in)
}

func (s *Server) handleDeletePrice(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeletePrice(r.Context(), r.PathValue("model")); err != nil {
		failErr(w, err)
		return
	}
	_ = s.pricer.Reload(r.Context())
	ok(w, map[string]string{"message": "price deleted"})
}

// handleUnpricedModels reports the models a channel serves but nobody has
// priced. Under the reject policy these are already refused; under the others
// they are the gateway's revenue leak, so surface them either way.
func (s *Server) handleUnpricedModels(w http.ResponseWriter, r *http.Request) {
	models, err := s.store.AllModels(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	missing := []string{}
	for _, m := range models {
		if _, status := s.pricer.Resolve(m); status != billing.PriceExact {
			missing = append(missing, m)
		}
	}
	ok(w, map[string]any{
		"data":   missing,
		"total":  len(missing),
		"policy": s.pricer.Settings().UnpricedPolicy,
	})
}

// --------------------------------------------------------- billing settings

func (s *Server) handleGetBillingSettings(w http.ResponseWriter, r *http.Request) {
	ok(w, s.pricer.Settings())
}

func (s *Server) handleUpdateBillingSettings(w http.ResponseWriter, r *http.Request) {
	var in billing.Settings
	if !decode(w, r, &in) {
		return
	}
	policy, err := billing.ParseUnpricedPolicy(string(in.UnpricedPolicy))
	if err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	in.UnpricedPolicy = policy
	if err := in.Validate(); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	for key, value := range in.Options() {
		if err := s.store.SetOption(r.Context(), key, value); err != nil {
			failErr(w, err)
			return
		}
	}
	if err := s.pricer.Reload(r.Context()); err != nil {
		failErr(w, err)
		return
	}
	slog.Info("billing policy updated", "policy", policy)
	ok(w, s.pricer.Settings())
}
