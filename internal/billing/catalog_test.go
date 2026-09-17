package billing

import (
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func existingPrices(prices ...model.ModelPrice) []*model.ModelPrice {
	out := make([]*model.ModelPrice, len(prices))
	for i := range prices {
		out[i] = &prices[i]
	}
	return out
}

func TestPlanImportAddsOnlyMissingModels(t *testing.T) {
	existing := existingPrices(
		model.ModelPrice{Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25},
		model.ModelPrice{Model: "hand-rolled", InputPrice: 7, OutputPrice: 7},
	)
	incoming := []model.ModelPrice{
		{Model: "gpt-4o", InputPrice: 99, OutputPrice: 99}, // re-priced by the feed
		{Model: "gpt-5", InputPrice: 1.25, OutputPrice: 10},
	}

	plan := planImport(existing, incoming, false)

	if len(plan.Added) != 1 || plan.Added[0].Model != "gpt-5" {
		t.Fatalf("added = %+v, want just gpt-5", plan.Added)
	}
	if len(plan.Changed) != 0 {
		t.Errorf("changed = %+v, want none without overwrite", plan.Changed)
	}
	if plan.Kept != 1 {
		t.Errorf("kept = %d, want 1", plan.Kept)
	}
	if plan.Total != 2 {
		t.Errorf("total = %d, want 2", plan.Total)
	}
}

func TestPlanImportOverwriteReportsChanges(t *testing.T) {
	existing := existingPrices(model.ModelPrice{
		Model: "deepseek-v4-flash", InputPrice: 0.14, OutputPrice: 0.28,
		CachedPrice: 0.0028, PerRequestPrice: 0.05,
	})
	incoming := []model.ModelPrice{
		{Model: "deepseek-v4-flash", InputPrice: 0.15, OutputPrice: 0.6, CachedPrice: 0.003},
	}

	plan := planImport(existing, incoming, true)

	if len(plan.Changed) != 1 {
		t.Fatalf("changed = %+v, want one row", plan.Changed)
	}
	change := plan.Changed[0]
	if change.Old.InputPrice != 0.14 || change.New.InputPrice != 0.15 {
		t.Errorf("change = %+v, want the old and new rates side by side", change)
	}
	// The catalogue has no notion of per-request pricing, so overwriting must
	// not wipe a rate the operator set by hand.
	if change.New.PerRequestPrice != 0.05 {
		t.Errorf("per-request price = %v, want the operator's 0.05 kept",
			change.New.PerRequestPrice)
	}
}

func TestPlanImportOverwriteSkipsIdenticalRates(t *testing.T) {
	existing := existingPrices(model.ModelPrice{
		Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25,
	})
	incoming := []model.ModelPrice{
		{Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25},
	}

	plan := planImport(existing, incoming, true)

	if plan.Unchanged != 1 || len(plan.Changed) != 0 || len(plan.Added) != 0 {
		t.Fatalf("plan = %+v, want one unchanged row and no writes", plan)
	}
}

func TestPlanImportMatchesRowsCaseInsensitively(t *testing.T) {
	// Billing lower-cases the model name, so GPT-4o and gpt-4o are one model;
	// importing must update the row rather than add a twin.
	existing := existingPrices(model.ModelPrice{Model: "GPT-4o", InputPrice: 1, OutputPrice: 1})
	incoming := []model.ModelPrice{{Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10}}

	plan := planImport(existing, incoming, true)

	if len(plan.Added) != 0 {
		t.Fatalf("added = %+v, want the case-variant treated as existing", plan.Added)
	}
	if len(plan.Changed) != 1 || plan.Changed[0].New.Model != "GPT-4o" {
		t.Fatalf("changed = %+v, want the stored spelling preserved", plan.Changed)
	}
}

func TestPlanImportLeavesUnknownExistingModelsAlone(t *testing.T) {
	// models.dev drops model ids that clients still send, and an existing
	// price is the only thing keeping such a request billable. Nothing in an
	// import may remove it.
	existing := existingPrices(
		model.ModelPrice{Model: "deepseek-chat", InputPrice: 0.14, OutputPrice: 0.28},
		model.ModelPrice{Model: "kimi-k2.5", InputPrice: 0.6, OutputPrice: 2.5},
	)
	incoming := []model.ModelPrice{{Model: "gpt-5", InputPrice: 1.25, OutputPrice: 10}}

	plan := planImport(existing, incoming, true)

	if len(plan.Added) != 1 || len(plan.Changed) != 0 {
		t.Fatalf("plan = %+v, want a single addition", plan)
	}
}
