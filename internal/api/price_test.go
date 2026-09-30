package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
)

// unpricedHarness wires a channel serving a model nobody has priced.
func unpricedHarness(t *testing.T) (*harness, *upstream, string) {
	t.Helper()
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1000, 500)
	})
	h.createChannel(channelInput{
		Name: "exotic", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"deepseek-v3"}, Groups: []string{"default"},
	})
	return h, up, h.createKey()
}

func TestUnpricedModelIsRefusedByDefault(t *testing.T) {
	h, up, key := unpricedHarness(t)

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for a model with no price", resp.StatusCode)
	}
	// The refusal must happen before any upstream tokens are spent.
	if got := up.requests.Load(); got != 0 {
		t.Fatalf("the upstream was called %d time(s); an unpriced model must never be relayed", got)
	}

	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "model_not_priced") {
		t.Fatalf("error payload does not name the cause: %s", raw)
	}

	// A priced model on the same gateway keeps working.
	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "deepseek-v3", InputPrice: 0.27, OutputPrice: 1.1}, nil)

	resp2 := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 once the model is priced", resp2.StatusCode)
	}

	// Both the refusal and the successful call are logged; the settlement
	// goroutines race, so pick the entry by status rather than by position.
	h.waitForLog(t, 2)
	entry := h.logByStatus(t, http.StatusOK)

	// 1000 * 0.27 + 500 * 1.1 = 820 micro-USD.
	if entry.Cost != 820 {
		t.Fatalf("cost = %d micro-USD, want 820", entry.Cost)
	}
}

func TestFallbackPolicyBillsUnpricedModels(t *testing.T) {
	h, up, key := unpricedHarness(t)

	settings := billing.Settings{
		UnpricedPolicy: billing.PolicyFallback,
		Fallback:       billing.FallbackPrice{InputPrice: 1, OutputPrice: 3},
	}
	if resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin, settings, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("update billing settings: HTTP %d", resp.StatusCode)
	}

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 under the fallback policy", resp.StatusCode)
	}
	if got := up.requests.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}

	// 1000 * $1/1M + 500 * $3/1M = 2500 micro-USD, charged to the caller.
	entry := h.waitForLog(t, 1)
	if entry.Cost != 2500 {
		t.Fatalf("cost = %d micro-USD, want 2500", entry.Cost)
	}
	h.waitFor(t, "the balance to be debited", func() bool {
		user, err := h.store.GetUser(context.Background(), entry.UserID)
		return err == nil && user.UsedQuota == 2500
	})
}

func TestFreePolicyRestoresTheOldBehaviour(t *testing.T) {
	h, _, key := unpricedHarness(t)

	settings := billing.Settings{UnpricedPolicy: billing.PolicyFree}
	if resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin, settings, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("update billing settings: HTTP %d", resp.StatusCode)
	}

	resp := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"deepseek-v3"}`)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 under the free policy", resp.StatusCode)
	}

	entry := h.waitForLog(t, 1)
	if entry.Cost != 0 {
		t.Fatalf("cost = %d, want 0 under the free policy", entry.Cost)
	}
	// Usage is still recorded even though nothing is charged.
	if entry.TotalTokens != 1500 {
		t.Fatalf("total_tokens = %d, want 1500", entry.TotalTokens)
	}
}

func TestBillingSettingsRejectAnUnchargeableFallback(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin,
		billing.Settings{UnpricedPolicy: billing.PolicyFallback}, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a fallback policy with no prices", resp.StatusCode)
	}

	resp2 := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin,
		billing.Settings{UnpricedPolicy: "nonsense"}, nil)
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for an unknown policy", resp2.StatusCode)
	}

	// The rejected writes must not have changed anything.
	var current billing.Settings
	h.do(http.MethodGet, "/api/admin/billing/settings", h.admin, nil, &current)
	if current.UnpricedPolicy != billing.PolicyReject {
		t.Fatalf("policy = %q, want it unchanged at %q", current.UnpricedPolicy, billing.PolicyReject)
	}
}

func TestUnpricedModelsAudit(t *testing.T) {
	h, _, _ := unpricedHarness(t)

	var report struct {
		Data  []string `json:"data"`
		Total int      `json:"total"`
	}
	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)

	if report.Total != 1 || len(report.Data) != 1 || report.Data[0] != "deepseek-v3" {
		t.Fatalf("audit = %+v, want just deepseek-v3", report)
	}

	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "deepseek-v3", InputPrice: 0.27}, nil)

	h.do(http.MethodGet, "/api/admin/prices/unpriced", h.admin, nil, &report)
	if report.Total != 0 {
		t.Fatalf("audit still reports %v after pricing the model", report.Data)
	}
}

// priceImportPlan mirrors the console's dry-run payload.
type priceImportPlan struct {
	DryRun    bool               `json:"dry_run"`
	Overwrite bool               `json:"overwrite"`
	Total     int                `json:"total"`
	Added     []model.ModelPrice `json:"added"`
	Changed   []struct {
		Model string           `json:"model"`
		Old   model.ModelPrice `json:"old"`
		New   model.ModelPrice `json:"new"`
	} `json:"changed"`
	Kept       int    `json:"kept"`
	Unchanged  int    `json:"unchanged"`
	FeedSHA256 string `json:"feed_sha256"`
}

type priceListing struct {
	Data    []model.ModelPrice `json:"data"`
	Catalog struct {
		Source   string  `json:"source"`
		URL      string  `json:"url"`
		SyncedAt *string `json:"synced_at"`
	} `json:"catalog"`
}

// price reads one row back out of the table, through the console's own API.
func (h *harness) price(t *testing.T, name string) model.ModelPrice {
	t.Helper()
	var listing priceListing
	resp := h.do(http.MethodGet, "/api/admin/prices", h.admin, nil, &listing)
	resp.Body.Close()
	for _, price := range listing.Data {
		if price.Model == name {
			return price
		}
	}
	t.Fatalf("no price configured for %s", name)
	return model.ModelPrice{}
}

func TestPriceListReportsWhereTheCatalogueComesFrom(t *testing.T) {
	h := newHarness(t)

	var before priceListing
	h.do(http.MethodGet, "/api/admin/prices", h.admin, nil, &before).Body.Close()
	if before.Catalog.URL != h.feed.url() {
		t.Errorf("catalog url = %q, want the configured endpoint", before.Catalog.URL)
	}
	if before.Catalog.Source != billing.CatalogSource {
		t.Errorf("catalog source = %q, want %q", before.Catalog.Source, billing.CatalogSource)
	}
	// Null, not a zero timestamp: the console has to tell "never imported"
	// from "imported at the epoch".
	if before.Catalog.SyncedAt != nil {
		t.Errorf("synced_at = %q before any import, want null", *before.Catalog.SyncedAt)
	}

	h.do(http.MethodPost, "/api/admin/prices/import", h.admin, nil, nil).Body.Close()

	var after priceListing
	h.do(http.MethodGet, "/api/admin/prices", h.admin, nil, &after).Body.Close()
	if after.Catalog.SyncedAt == nil {
		t.Fatal("synced_at is still null after a successful import")
	}
}

func TestPriceImportPreviewWritesNothing(t *testing.T) {
	h := newHarness(t)
	h.feed.set(feedBody(t, repriced("gpt-4o", 9)))

	var preview priceImportPlan
	resp := h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true&dry_run=true",
		h.admin, nil, &preview)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("preview: HTTP %d", resp.StatusCode)
	}
	if !preview.DryRun {
		t.Error("the response did not mark itself as a dry run")
	}
	if len(preview.Changed) != 1 || preview.Changed[0].Model != "gpt-4o" {
		t.Fatalf("changed = %+v, want the one re-priced model", preview.Changed)
	}
	if got := preview.Changed[0].New.InputPrice; got != 9 {
		t.Errorf("previewed rate = %v, want 9", got)
	}
	// The point of a dry run: the table still bills what it billed before.
	if got := h.price(t, "gpt-4o").InputPrice; got != 2.5 {
		t.Fatalf("gpt-4o input = %v after a dry run, want the 2.5 left untouched", got)
	}
}

// The confirmed preview is what lands. Applying the plan the dry run
// returned must not re-plan against a catalogue that moved in between.
func TestPriceImportAppliesThePreviewedPlan(t *testing.T) {
	h := newHarness(t)
	h.feed.set(feedBody(t, repriced("gpt-4o", 9)))

	var preview priceImportPlan
	resp := h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true&dry_run=true",
		h.admin, nil, &preview)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("preview: HTTP %d", resp.StatusCode)
	}
	if preview.FeedSHA256 == "" {
		t.Fatal("the plan carries no feed hash; the write could not be verified against it")
	}

	// The feed moves after the operator saw the diff.
	h.feed.set(feedBody(t, repriced("gpt-4o", 99)))

	var written priceImportPlan
	resp = h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true", h.admin, &preview, &written)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("apply: HTTP %d", resp.StatusCode)
	}
	if got := h.price(t, "gpt-4o").InputPrice; got != 9 {
		t.Errorf("input = %v, want the previewed 9, not the moved 99", got)
	}
}

// A plan computed from a feed the importer has since moved past is refused:
// the operator confirms one catalogue, and a different one must not land
// instead. Two admins: A previewed before the catalogue updated, B after.
func TestPriceImportRefusesAPlanFromAMovedFeed(t *testing.T) {
	h := newHarness(t)
	h.feed.set(feedBody(t, repriced("gpt-4o", 9)))

	var stale priceImportPlan
	resp := h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true&dry_run=true",
		h.admin, nil, &stale)
	resp.Body.Close()

	h.feed.set(feedBody(t, repriced("gpt-4o", 99)))

	var fresh priceImportPlan
	resp = h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true&dry_run=true",
		h.admin, nil, &fresh)
	resp.Body.Close()

	// A confirms the plan from before the update.
	resp = h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true", h.admin, &stale, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("status = %d, want 409 for a plan the importer has moved past", resp.StatusCode)
	}
	if got := h.price(t, "gpt-4o").InputPrice; got != 2.5 {
		t.Errorf("input = %v, want the operator's 2.5 untouched by the refused plan", got)
	}

	// Re-previewing clears it: the fresh plan applies.
	resp = h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true", h.admin, &fresh, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fresh plan: HTTP %d, want applied", resp.StatusCode)
	}
	if got := h.price(t, "gpt-4o").InputPrice; got != 99 {
		t.Errorf("input = %v, want the fresh preview's 99", got)
	}
}

func TestPriceImportIsAdditiveByDefault(t *testing.T) {
	h := newHarness(t)
	grown := repriced("gpt-4o", 9)
	grown["gpt-5.2"] = feedModel{input: 1.75, output: 14, cached: 0.175}
	h.feed.set(feedBody(t, grown))

	var plan priceImportPlan
	resp := h.do(http.MethodPost, "/api/admin/prices/import", h.admin, nil, &plan)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("import: HTTP %d", resp.StatusCode)
	}

	if len(plan.Added) != 1 || plan.Added[0].Model != "gpt-5.2" {
		t.Fatalf("added = %+v, want just gpt-5.2", plan.Added)
	}
	if len(plan.Changed) != 0 {
		t.Errorf("changed = %+v, want none: the operator's own rate outranks the catalogue",
			plan.Changed)
	}
	if want := len(testCatalogue()); plan.Kept != want {
		t.Errorf("kept = %d, want %d", plan.Kept, want)
	}

	// The re-priced model keeps the operator's rate; only the new one lands.
	if got := h.price(t, "gpt-4o").InputPrice; got != 2.5 {
		t.Errorf("gpt-4o input = %v, want the operator's 2.5 kept", got)
	}
	if got := h.price(t, "gpt-5.2").InputPrice; got != 1.75 {
		t.Errorf("gpt-5.2 input = %v, want the imported 1.75", got)
	}
}

func TestPriceImportOverwriteRewritesRates(t *testing.T) {
	h := newHarness(t)
	h.feed.set(feedBody(t, repriced("gpt-4o", 9)))

	// A flat fee the catalogue knows nothing about: overwriting the token
	// rates must not quietly drop it.
	if err := h.store.UpsertPrice(context.Background(), &model.ModelPrice{
		Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25,
		PerRequestPrice: 0.05,
	}); err != nil {
		t.Fatal(err)
	}

	var plan priceImportPlan
	resp := h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true", h.admin, nil, &plan)
	resp.Body.Close()
	if len(plan.Changed) != 1 {
		t.Fatalf("changed = %+v, want the one re-priced model", plan.Changed)
	}
	// Every other row already matches the catalogue, so it is not rewritten.
	if plan.Unchanged != len(testCatalogue())-1 {
		t.Errorf("unchanged = %d, want %d", plan.Unchanged, len(testCatalogue())-1)
	}

	price := h.price(t, "gpt-4o")
	if price.InputPrice != 9 {
		t.Errorf("input = %v, want the catalogue's 9", price.InputPrice)
	}
	if price.PerRequestPrice != 0.05 {
		t.Errorf("per-request = %v, want the operator's 0.05 kept", price.PerRequestPrice)
	}
}

// A price that lands in Postgres but not in memory would keep billing the old
// rate until the next refresh, so the import has to reach the pricer too.
func TestImportedPricesReachBilling(t *testing.T) {
	h := newHarness(t)
	h.feed.set(feedBody(t, repriced("gpt-4o", 1)))

	resp := h.do(http.MethodPost, "/api/admin/prices/import?overwrite=true", h.admin, nil, nil)
	resp.Body.Close()

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1000, 1000)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	key := h.createKey()

	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()

	entry := h.waitForLog(t, 1)
	// 1000 * 1 (the imported input rate) + 1000 * 10 (output, untouched) = 11000.
	if entry.Cost != 11000 {
		t.Fatalf("cost = %d micro-USD, want the imported input rate billed", entry.Cost)
	}
}

// A broken catalogue is the upstream's fault: 502 tells the operator
// models.dev (or the mirror) is the problem, not this gateway.
func TestPriceImportReportsABrokenCatalogueAsBadGateway(t *testing.T) {
	h := newHarness(t)
	h.feed.set("not json")

	resp := h.do(http.MethodPost, "/api/admin/prices/import", h.admin, nil, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502 for an unusable catalogue", resp.StatusCode)
	}
}

func TestPriceImportIsRefusedWithoutAnEndpoint(t *testing.T) {
	h := newHarnessWithoutCatalogue(t)

	resp := h.do(http.MethodPost, "/api/admin/prices/import", h.admin, nil, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 when MODELS_DEV_URL is unset", resp.StatusCode)
	}
}

// UpsertPrices is one transaction: a row that fails mid-batch must leave the
// earlier rows and the sync stamp unwritten. PostgreSQL rejects NUL bytes in
// text, which gives the test a deterministic mid-batch failure.
func TestUpsertPricesIsAtomic(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	rows := []*model.ModelPrice{
		{Model: "atomic-good-one", InputPrice: 1, OutputPrice: 2},
		{Model: "atomic-\x00bad", InputPrice: 1, OutputPrice: 2},
		{Model: "atomic-good-two", InputPrice: 1, OutputPrice: 2},
	}
	err := h.store.UpsertPrices(ctx, rows, billing.OptCatalogSyncedAt, "2026-01-01T00:00:00Z")
	if err == nil {
		t.Fatal("a NUL byte in a model name should have failed the batch")
	}

	prices, err := h.store.ListPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, price := range prices {
		if price.Model == "atomic-good-one" || price.Model == "atomic-good-two" {
			t.Errorf("%s survived a failed batch; the import is not all-or-nothing", price.Model)
		}
	}
	if _, err := h.store.GetOption(ctx, billing.OptCatalogSyncedAt); err == nil {
		t.Error("the sync stamp was written by a failed import")
	}
}

// The unattended seed has nobody reviewing a diff, so a feed that looks
// structurally wrong must not become the billing table.
func TestSeedIfEmptyRefusesASuspiciouslySmallCatalogue(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// Make the table empty and un-synced, as on a fresh install.
	for name := range testCatalogue() {
		if err := h.store.DeletePrice(ctx, name); err != nil {
			t.Fatal(err)
		}
	}

	// The harness feed holds 9 models — far below what models.dev carries.
	seeded, err := billing.NewImporter(h.store, h.feed.url()).SeedIfEmpty(ctx)
	if err == nil {
		t.Fatal("a 9-model catalogue should not pass the unattended guard")
	}
	if seeded {
		t.Fatal("nothing may be seeded from a suspicious feed")
	}
	prices, err := h.store.ListPrices(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(prices) != 0 {
		t.Fatalf("table holds %d rows after a refused seed, want 0", len(prices))
	}

	// A full-size catalogue seeds normally.
	h.feed.set(feedBody(t, fullSizeCatalogue()))
	if seeded, err = billing.NewImporter(h.store, h.feed.url()).SeedIfEmpty(ctx); err != nil || !seeded {
		t.Fatalf("seeded = %v, err = %v, want a full-size feed to seed", seeded, err)
	}
	if _, err := h.store.GetOption(ctx, billing.OptCatalogSyncedAt); err != nil {
		t.Errorf("the sync stamp was not written: %v", err)
	}
}

// fullSizeCatalogue pads the fixture past the unattended seed's floor.
func fullSizeCatalogue() map[string]feedModel {
	out := testCatalogue()
	for i := 0; len(out) < 120; i++ {
		out[fmt.Sprintf("filler-%03d", i)] = feedModel{input: 1, output: 2}
	}
	return out
}

// The plaza lists what the caller can call. Under the reject policy an unpriced
// model would only ever answer 403, so it is not listed at all; under the free
// policy the same model relays, and it appears marked as missing a price.
func TestPlazaListsOnlyCallableModels(t *testing.T) {
	h, up, _ := unpricedHarness(t)
	h.createChannel(channelInput{
		Name: "priced", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	plaza := func() map[string]string {
		var out struct {
			Data []struct {
				Model       string `json:"model"`
				PriceStatus string `json:"price_status"`
			} `json:"data"`
		}
		resp := h.do(http.MethodGet, "/api/me/plaza", h.admin, nil, &out)
		resp.Body.Close()
		listed := map[string]string{}
		for _, entry := range out.Data {
			listed[entry.Model] = entry.PriceStatus
		}
		return listed
	}

	listed := plaza()
	if listed["gpt-4o"] != "exact" {
		t.Fatalf("priced model missing from the plaza: %v", listed)
	}
	if _, found := listed["deepseek-v3"]; found {
		t.Fatalf("an unpriced model is listed under the reject policy: %v", listed)
	}

	settings := billing.Settings{UnpricedPolicy: billing.PolicyFree}
	if resp := h.do(http.MethodPut, "/api/admin/billing/settings", h.admin, settings, nil); resp.StatusCode != http.StatusOK {
		t.Fatalf("update billing settings: HTTP %d", resp.StatusCode)
	}
	if got := plaza()["deepseek-v3"]; got != "missing" {
		t.Fatalf("under the free policy the unpriced model should be listed as missing, got %q", got)
	}
}
