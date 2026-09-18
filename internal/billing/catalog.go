package billing

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/modelsdev"
	"github.com/faketoken/faketoken/internal/store"
)

// CatalogSource names where imported prices come from.
const CatalogSource = "models.dev"

// minCatalogueModels is the size below which a fetched catalogue looks
// broken rather than small. models.dev carries a few hundred first-party
// models; fewer than this means a degraded or reshaped response, and an
// unattended seed must not fill an empty table from it. The console's
// import shows a diff first, so it is not gated.
const minCatalogueModels = 100

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
	// DryRun exists so a preview response can be posted back verbatim as
	// the apply request; the server ignores it on the way in.
	DryRun bool `json:"dry_run,omitempty"`
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
	// FeedSHA256 identifies the feed this plan was computed from. Apply
	// refuses a plan whose feed is not the one most recently fetched, so a
	// stale preview cannot quietly land after the catalogue moved.
	FeedSHA256 string `json:"feed_sha256,omitempty"`
}

// ErrStaleFeed reports that a plan was computed from a different feed than
// the one most recently fetched. The console answers with a fresh preview.
var ErrStaleFeed = errors.New("the catalogue changed since this plan was previewed; pull it again")

// Importer copies the models.dev catalogue into the price table. It never
// deletes: models.dev drops names that clients are still sending, and a
// vanished price turns into a refused request under the reject policy.
type Importer struct {
	st     *store.Store
	client *http.Client
	url    string

	mu       sync.Mutex
	fetchSHA string // sha256 of the most recently fetched feed
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

// lastFetch reports the hash of the most recently fetched feed.
func (im *Importer) lastFetch() string {
	im.mu.Lock()
	defer im.mu.Unlock()
	return im.fetchSHA
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
	at, err := im.syncedAt(ctx)
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
	im.mu.Lock()
	im.fetchSHA = cat.FeedSHA256
	im.mu.Unlock()

	// A renamed provider id silently drops a whole vendor from the table.
	if len(cat.Missing) > 0 {
		slog.Warn("providers missing from the feed", "url", im.url, "providers", cat.Missing)
	}

	existing, err := im.st.ListPrices(ctx)
	if err != nil {
		return nil, err
	}
	plan := planImport(existing, cat.Prices, overwrite)
	plan.FeedSHA256 = cat.FeedSHA256
	return plan, nil
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
	addedKeys := make(map[string]struct{}, len(incoming))
	for _, price := range incoming {
		key := strings.ToLower(price.Model)
		old, ok := current[key]
		if !ok {
			// The catalogue is already deduplicated case-insensitively, but
			// this is a pure function with its own contract: a second
			// case-variant must not become a second row the pricer would
			// shadow. UpdatedAt stays zero: the row does not exist yet.
			if _, dup := addedKeys[key]; dup {
				continue
			}
			addedKeys[key] = struct{}{}
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
		// Carry the row's current stamp so the reported diff shows a real
		// time instead of the zero value; the upsert stamps it again on write.
		next.UpdatedAt = old.UpdatedAt
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

// Apply writes a plan and stamps the sync time, all in one transaction: a
// write interrupted halfway must leave the old prices standing, not a mix
// of old and new. A plan computed from a feed other than the one most
// recently fetched is refused: the operator confirmed a preview of one
// catalogue, and a different one must not land instead.
func (im *Importer) Apply(ctx context.Context, plan *ImportPlan) error {
	if plan.FeedSHA256 != im.lastFetch() {
		return ErrStaleFeed
	}

	rows := make([]*model.ModelPrice, 0, len(plan.Added)+len(plan.Changed))
	for i := range plan.Added {
		rows = append(rows, &plan.Added[i])
	}
	for i := range plan.Changed {
		rows = append(rows, &plan.Changed[i].New)
	}
	return im.st.UpsertPrices(ctx, rows, OptCatalogSyncedAt, time.Now().UTC().Format(time.RFC3339))
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

// SeedIfEmpty fills a price table that has never held anything: rows present,
// or a table deliberately emptied after a sync, both mean it is not empty.
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

	// Nobody reviews a diff on this path, so refuse a feed that looks
	// structurally wrong before it becomes the billing table.
	plan, err := im.Plan(ctx, false)
	if err != nil {
		return false, err
	}
	if plan.Total < minCatalogueModels {
		return false, fmt.Errorf("catalogue holds %d priced models, below the %d expected from %s; not seeding",
			plan.Total, minCatalogueModels, CatalogSource)
	}
	if err := im.Apply(ctx, plan); err != nil {
		return false, err
	}
	slog.Info("seeded the price table from the catalogue", "source", CatalogSource,
		"url", im.url, "models", len(plan.Added))
	return true, nil
}

// syncedAt reads the last sync stamp; zero when the catalogue was never
// imported.
func (im *Importer) syncedAt(ctx context.Context) (time.Time, error) {
	raw, err := im.st.GetOption(ctx, OptCatalogSyncedAt)
	if errors.Is(err, store.ErrNotFound) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, raw)
}
