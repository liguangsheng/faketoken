package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/modelsdev"
	"github.com/faketoken/faketoken/internal/store"
)

// CatalogSource names where imported prices come from.
const CatalogSource = "models.dev"

// OptCatalogSyncedAt records (RFC 3339) when the catalogue was last written
// into the price table. It lives in the options table next to the billing
// policy so the console can show it without a second store.
const OptCatalogSyncedAt = "prices.catalog_synced_at"

// PriceChange is one existing row an import would rewrite.
type PriceChange struct {
	Model string           `json:"model"`
	Old   model.ModelPrice `json:"old"`
	New   model.ModelPrice `json:"new"`
}

// ImportPlan is what importing the catalogue would do to the price table.
// Added and Changed are exactly what Apply writes; the rest is for the
// operator.
type ImportPlan struct {
	Overwrite bool `json:"overwrite"`
	// Added are models the table does not have yet.
	Added []model.ModelPrice `json:"added"`
	// Changed are existing rows the catalogue prices differently. Always
	// empty without Overwrite: an operator's own pricing outranks a
	// third-party catalogue unless they ask otherwise.
	Changed []PriceChange `json:"changed"`
	// Kept counts existing rows left alone because Overwrite was off.
	Kept int `json:"kept"`
	// Unchanged counts rows already at the catalogue's rate.
	Unchanged int `json:"unchanged"`
	// Total is how many models the catalogue offered.
	Total int `json:"total"`
}

// Importer copies the models.dev catalogue into the price table. It never
// deletes: models.dev drops names that clients are still sending, and a
// vanished price turns into a refused request under the reject policy.
type Importer struct {
	st     *store.Store
	client *http.Client
	url    string
}

func NewImporter(st *store.Store, url string) *Importer {
	return &Importer{
		st:  st,
		url: url,
		// The feed is a few megabytes from a CDN; a minute covers a slow link
		// without leaving the console hanging when the host has no egress.
		client: &http.Client{Timeout: 60 * time.Second},
	}
}

// URL reports where the catalogue is pulled from.
func (im *Importer) URL() string { return im.url }

// Enabled reports whether an endpoint is configured. A deployment with no
// egress leaves MODELS_DEV_URL empty and the console hides the import.
func (im *Importer) Enabled() bool { return im.url != "" }

// CatalogStatus tells the console where the table came from and when it was
// last filled.
type CatalogStatus struct {
	Source string `json:"source"`
	URL    string `json:"url"`
	// SyncedAt is null until the catalogue has been imported once.
	SyncedAt *time.Time `json:"synced_at"`
}

func (im *Importer) Status(ctx context.Context) CatalogStatus {
	status := CatalogStatus{Source: CatalogSource, URL: im.url}
	at, err := im.SyncedAt(ctx)
	switch {
	case err != nil:
		// Losing the timestamp must not take the price list down with it.
		slog.Warn("price catalogue sync time unreadable", "error", err)
	case !at.IsZero():
		status.SyncedAt = &at
	}
	return status
}

// Plan pulls the catalogue and works out what importing it would change,
// without writing anything.
func (im *Importer) Plan(ctx context.Context, overwrite bool) (*ImportPlan, error) {
	cat, err := modelsdev.Fetch(ctx, im.client, im.url)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", im.url, err)
	}
	// A renamed provider id silently drops a whole vendor from the table.
	if len(cat.Missing) > 0 {
		slog.Warn("providers missing from the feed", "url", im.url, "providers", cat.Missing)
	}

	existing, err := im.st.ListPrices(ctx)
	if err != nil {
		return nil, err
	}
	return planImport(existing, cat.Prices, overwrite), nil
}

// planImport is the pure half of Plan, so the modes are testable without a
// database.
func planImport(existing []*model.ModelPrice, incoming []model.ModelPrice, overwrite bool) *ImportPlan {
	// The pricer lower-cases its keys, so a row differing only in case is the
	// same model at billing time and must not become a second entry here.
	current := make(map[string]*model.ModelPrice, len(existing))
	for _, price := range existing {
		current[strings.ToLower(price.Model)] = price
	}

	plan := &ImportPlan{
		Overwrite: overwrite,
		Total:     len(incoming),
		// Empty rather than nil so the API reports [] instead of null.
		Added:   []model.ModelPrice{},
		Changed: []PriceChange{},
	}
	for _, price := range incoming {
		old, ok := current[strings.ToLower(price.Model)]
		if !ok {
			plan.Added = append(plan.Added, price)
			continue
		}
		if !overwrite {
			plan.Kept++
			continue
		}

		// The catalogue knows nothing about per-request pricing, and the row
		// keeps its exact name so the upsert hits it instead of inserting a
		// case-variant twin.
		next := price
		next.Model = old.Model
		next.PerRequestPrice = old.PerRequestPrice
		if sameRates(*old, next) {
			plan.Unchanged++
			continue
		}
		plan.Changed = append(plan.Changed, PriceChange{Model: old.Model, Old: *old, New: next})
	}
	return plan
}

func sameRates(a, b model.ModelPrice) bool {
	return a.InputPrice == b.InputPrice &&
		a.OutputPrice == b.OutputPrice &&
		a.CachedPrice == b.CachedPrice
}

// Apply writes a plan and stamps the sync time.
func (im *Importer) Apply(ctx context.Context, plan *ImportPlan) error {
	for i := range plan.Added {
		// Copy: the store takes a pointer, and the plan is reported back to
		// the caller unmodified.
		row := plan.Added[i]
		if err := im.st.UpsertPrice(ctx, &row); err != nil {
			return err
		}
	}
	for i := range plan.Changed {
		row := plan.Changed[i].New
		if err := im.st.UpsertPrice(ctx, &row); err != nil {
			return err
		}
	}
	return im.st.SetOption(ctx, OptCatalogSyncedAt, time.Now().UTC().Format(time.RFC3339))
}

// Import is Plan followed by Apply.
func (im *Importer) Import(ctx context.Context, overwrite bool) (*ImportPlan, error) {
	plan, err := im.Plan(ctx, overwrite)
	if err != nil {
		return nil, err
	}
	if err := im.Apply(ctx, plan); err != nil {
		return nil, err
	}
	slog.Info("imported price catalogue", "source", CatalogSource, "url", im.url,
		"overwrite", overwrite, "added", len(plan.Added), "changed", len(plan.Changed),
		"kept", plan.Kept, "unchanged", plan.Unchanged)
	return plan, nil
}

// SeedIfEmpty fills a price table that has never held anything. A table with
// rows, or one the operator synced and then emptied on purpose, is left
// alone: refilling it would start billing a gateway that was meant to be
// free.
func (im *Importer) SeedIfEmpty(ctx context.Context) (seeded bool, err error) {
	existing, err := im.st.ListPrices(ctx)
	if err != nil {
		return false, err
	}
	if len(existing) > 0 {
		return false, nil
	}
	// A stamp without rows means the operator synced and then cleared the
	// table on purpose; refilling it would start billing a gateway that was
	// meant to be free.
	if _, err := im.st.GetOption(ctx, OptCatalogSyncedAt); err == nil {
		return false, nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return false, err
	}

	if _, err := im.Import(ctx, false); err != nil {
		return false, err
	}
	return true, nil
}

// SyncedAt reads the last sync stamp; zero when the catalogue was never
// imported.
func (im *Importer) SyncedAt(ctx context.Context) (time.Time, error) {
	raw, err := im.st.GetOption(ctx, OptCatalogSyncedAt)
	if errors.Is(err, store.ErrNotFound) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, raw)
}
