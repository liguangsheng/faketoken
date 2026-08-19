package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

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

	logs, total, err := s.store.ListLogs(r.Context(), f)
	if err != nil {
		failErr(w, err)
		return
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
		"catalog": map[string]any{
			"total":        billing.CatalogSize(),
			"source":       billing.CatalogSource,
			"generated_at": billing.CatalogGeneratedAt,
		},
	})
}

// handleImportPrices copies the built-in models.dev snapshot into the price
// table. It is deliberately additive by default: an operator's own rates
// outrank a third-party catalogue unless they ask for the overwrite.
func (s *Server) handleImportPrices(w http.ResponseWriter, r *http.Request) {
	overwrite := queryBool(r, "overwrite")

	imported, skipped, err := billing.ImportCatalog(r.Context(), s.store, overwrite)
	if err != nil {
		failErr(w, err)
		return
	}
	if err := s.pricer.Reload(r.Context()); err != nil {
		failErr(w, err)
		return
	}

	slog.Info("imported built-in price catalogue",
		"source", billing.CatalogSource, "snapshot", billing.CatalogGeneratedAt,
		"overwrite", overwrite, "imported", imported, "skipped", skipped)
	ok(w, map[string]any{
		"imported":     imported,
		"skipped":      skipped,
		"total":        billing.CatalogSize(),
		"source":       billing.CatalogSource,
		"generated_at": billing.CatalogGeneratedAt,
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
