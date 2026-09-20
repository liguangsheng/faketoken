package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/modelsdev"
)

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
