package billing

import (
	"context"
	"log/slog"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// Catalog returns a copy of the built-in price table (USD per 1M tokens),
// pulled from models.dev by cmd/genprices. It is a starting point, not the
// truth: operators are expected to curate it in the console.
func Catalog() []model.ModelPrice {
	out := make([]model.ModelPrice, len(catalog))
	copy(out, catalog)
	return out
}

// CatalogSize reports how many models the built-in table covers.
func CatalogSize() int { return len(catalog) }

// ImportCatalog writes the built-in table into the database.
//
// With overwrite false, models that already have a row keep it: a snapshot
// must never silently undo an operator's own pricing. With overwrite true the
// catalogue wins, which is what an explicit "sync prices" action asks for.
func ImportCatalog(ctx context.Context, st *store.Store, overwrite bool) (imported, skipped int, err error) {
	existing, err := st.ListPrices(ctx)
	if err != nil {
		return 0, 0, err
	}
	known := make(map[string]struct{}, len(existing))
	for _, price := range existing {
		known[strings.ToLower(price.Model)] = struct{}{}
	}

	for i := range catalog {
		if _, ok := known[strings.ToLower(catalog[i].Model)]; ok && !overwrite {
			skipped++
			continue
		}
		// Copy: the store takes a pointer and stamps UpdatedAt on it, which
		// would otherwise mutate the package-level table.
		row := catalog[i]
		if err := st.UpsertPrice(ctx, &row); err != nil {
			return imported, skipped, err
		}
		imported++
	}
	return imported, skipped, nil
}

// SeedDefaults installs the catalogue the first time the service runs. An
// existing table is left completely alone, including a deliberately empty one
// that the operator has already curated down to nothing.
func SeedDefaults(ctx context.Context, st *store.Store) error {
	existing, err := st.ListPrices(ctx)
	if err != nil {
		return err
	}
	if len(existing) > 0 {
		return nil
	}
	imported, _, err := ImportCatalog(ctx, st, false)
	if err != nil {
		return err
	}
	slog.Info("seeded model prices",
		"source", CatalogSource, "snapshot", CatalogGeneratedAt, "models", imported)
	return nil
}
