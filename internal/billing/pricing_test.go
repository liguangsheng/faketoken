package billing

import (
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

// testPricer builds a pricer without a database: everything under test here
// reads the in-memory tables that Reload would otherwise fill.
func testPricer(settings Settings, prices ...model.ModelPrice) *Pricer {
	p := &Pricer{
		defaults: settings.normalise(),
		settings: settings.normalise(),
		prices:   map[string]*model.ModelPrice{},
		groups:   map[string]float64{},
	}
	for i := range prices {
		p.prices[strings.ToLower(prices[i].Model)] = &prices[i]
	}
	return p
}

var gpt4o = model.ModelPrice{Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25}

func TestLookupMatchesLongestPrefix(t *testing.T) {
	p := testPricer(DefaultSettings(),
		gpt4o,
		model.ModelPrice{Model: "gpt-4o-mini", InputPrice: 0.15, OutputPrice: 0.6},
	)

	cases := []struct {
		name  string
		want  string
		found bool
	}{
		{"gpt-4o", "gpt-4o", true},
		{"GPT-4O", "gpt-4o", true},                      // case-insensitive
		{"  gpt-4o  ", "gpt-4o", true},                  // trimmed
		{"gpt-4o-2024-11-20", "gpt-4o", true},           // dated snapshot inherits the family
		{"gpt-4o-mini-2024-07-18", "gpt-4o-mini", true}, // longest prefix wins
		{"claude-sonnet-4", "", false},
		{"gpt-4", "", false}, // prefixes only work in one direction
		{"", "", false},
	}

	for _, tc := range cases {
		got, ok := p.Lookup(tc.name)
		if ok != tc.found {
			t.Fatalf("Lookup(%q) found = %v, want %v", tc.name, ok, tc.found)
		}
		if ok && got.Model != tc.want {
			t.Fatalf("Lookup(%q) = %q, want %q", tc.name, got.Model, tc.want)
		}
	}
}

func TestCostPricedModel(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)

	// 1000 fresh input @ $2.50/1M + 500 output @ $10/1M = 2500 + 5000.
	usage := model.Usage{PromptTokens: 1000, CompletionTokens: 500, TotalTokens: 1500}
	cost, status := p.Cost("gpt-4o", usage, "default", 1)
	if status != PriceExact {
		t.Fatalf("status = %v, want PriceExact", status)
	}
	if cost != 7500 {
		t.Fatalf("cost = %d micro-USD, want 7500", cost)
	}
}

func TestCostChargesCachedTokensSeparately(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)

	// 200 cached @ $1.25/1M + 800 fresh @ $2.50/1M = 250 + 2000.
	usage := model.Usage{PromptTokens: 1000, CachedTokens: 200}
	cost, _ := p.Cost("gpt-4o", usage, "default", 1)
	if cost != 2250 {
		t.Fatalf("cost = %d, want 2250", cost)
	}
}

func TestCostClampsCachedToPromptTokens(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)

	// A provider reporting more cached than prompt tokens must not produce a
	// negative fresh count, which would refund the caller.
	usage := model.Usage{PromptTokens: 100, CachedTokens: 900}
	cost, _ := p.Cost("gpt-4o", usage, "default", 1)
	if cost != 125 { // 100 cached @ $1.25/1M, zero fresh
		t.Fatalf("cost = %d, want 125", cost)
	}
}

func TestCostFallsBackToInputPriceForCachedTokens(t *testing.T) {
	p := testPricer(DefaultSettings(),
		model.ModelPrice{Model: "gpt-4-turbo", InputPrice: 10, OutputPrice: 30},
	)

	usage := model.Usage{PromptTokens: 1000, CachedTokens: 1000}
	cost, _ := p.Cost("gpt-4-turbo", usage, "default", 1)
	if cost != 10_000 { // cached billed at the input price when unset
		t.Fatalf("cost = %d, want 10000", cost)
	}
}

func TestCostAddsPerRequestPrice(t *testing.T) {
	p := testPricer(DefaultSettings(),
		model.ModelPrice{Model: "dall-e-3", PerRequestPrice: 0.04},
	)

	cost, status := p.Cost("dall-e-3", model.Usage{}, "default", 1)
	if status != PriceExact {
		t.Fatalf("status = %v, want PriceExact", status)
	}
	if cost != 40_000 { // $0.04
		t.Fatalf("cost = %d, want 40000", cost)
	}
}

func TestCostAppliesGroupAndChannelRatios(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)
	p.groups["vip"] = 0.5

	usage := model.Usage{PromptTokens: 1000, CompletionTokens: 500}
	cost, _ := p.Cost("gpt-4o", usage, "vip", 2)
	if cost != 7500 { // 7500 * 0.5 * 2
		t.Fatalf("cost = %d, want 7500", cost)
	}
}

func TestNonPositiveRatiosNeverZeroTheBill(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)
	p.groups["broken"] = 0 // only reachable by editing the database directly

	usage := model.Usage{PromptTokens: 1000, CompletionTokens: 500}

	if rate := p.GroupRate("broken"); rate != 1 {
		t.Fatalf("GroupRate = %v, want 1 for a non-positive rate", rate)
	}
	if cost, _ := p.Cost("gpt-4o", usage, "broken", 1); cost != 7500 {
		t.Fatalf("cost = %d, want 7500 despite the zero group rate", cost)
	}
	if cost, _ := p.Cost("gpt-4o", usage, "default", 0); cost != 7500 {
		t.Fatalf("cost = %d, want 7500 despite the zero channel ratio", cost)
	}
	if cost, _ := p.Cost("gpt-4o", usage, "default", -3); cost != 7500 {
		t.Fatalf("cost = %d, want 7500 despite the negative channel ratio", cost)
	}
}

// ------------------------------------------------- unpriced model behaviour

func TestUnpricedModelReportsMissingRatherThanZero(t *testing.T) {
	p := testPricer(DefaultSettings(), gpt4o)

	usage := model.Usage{PromptTokens: 1000, CompletionTokens: 500}
	cost, status := p.Cost("deepseek-v3", usage, "default", 1)
	if status != PriceMissing {
		t.Fatalf("status = %v, want PriceMissing", status)
	}
	if cost != 0 {
		t.Fatalf("cost = %d, want 0", cost)
	}
	// A zero cost on a priced model must stay distinguishable from this one.
	if _, status := p.Cost("gpt-4o", model.Usage{}, "default", 1); status != PriceExact {
		t.Fatalf("an empty usage on a priced model reported %v, want PriceExact", status)
	}
}

func TestRejectPolicyBlocksUnpricedModels(t *testing.T) {
	p := testPricer(Settings{UnpricedPolicy: PolicyReject}, gpt4o)

	if !p.Blocked("deepseek-v3") {
		t.Fatal("an unpriced model must be blocked under the reject policy")
	}
	if p.Blocked("gpt-4o") {
		t.Fatal("a priced model must never be blocked")
	}
	if p.Blocked("gpt-4o-2024-11-20") {
		t.Fatal("a model priced by prefix must never be blocked")
	}
}

func TestFreePolicyRelaysUnpricedModels(t *testing.T) {
	p := testPricer(Settings{UnpricedPolicy: PolicyFree}, gpt4o)

	if p.Blocked("deepseek-v3") {
		t.Fatal("the free policy must not block anything")
	}
	cost, status := p.Cost("deepseek-v3", model.Usage{PromptTokens: 1000}, "default", 1)
	if cost != 0 || status != PriceMissing {
		t.Fatalf("cost = %d status = %v, want 0 / PriceMissing", cost, status)
	}
}

func TestFallbackPolicyBillsUnpricedModels(t *testing.T) {
	p := testPricer(Settings{
		UnpricedPolicy: PolicyFallback,
		Fallback:       FallbackPrice{InputPrice: 1, OutputPrice: 3},
	}, gpt4o)

	if p.Blocked("deepseek-v3") {
		t.Fatal("a chargeable fallback must not block the request")
	}

	usage := model.Usage{PromptTokens: 1000, CompletionTokens: 500}
	cost, status := p.Cost("deepseek-v3", usage, "default", 1)
	if status != PriceFallback {
		t.Fatalf("status = %v, want PriceFallback", status)
	}
	if cost != 2500 { // 1000*1 + 500*3
		t.Fatalf("cost = %d, want 2500", cost)
	}

	// A model with its own entry still wins over the fallback.
	if _, status := p.Cost("gpt-4o", usage, "default", 1); status != PriceExact {
		t.Fatalf("status = %v, want PriceExact", status)
	}
}

func TestFallbackPolicyWithoutPricesIsNotChargeable(t *testing.T) {
	// An all-zero fallback is the free policy in disguise; it must not silently
	// pretend the request was billed.
	p := testPricer(Settings{UnpricedPolicy: PolicyFallback}, gpt4o)

	cost, status := p.Cost("deepseek-v3", model.Usage{PromptTokens: 1000}, "default", 1)
	if cost != 0 || status != PriceMissing {
		t.Fatalf("cost = %d status = %v, want 0 / PriceMissing", cost, status)
	}
}

// -------------------------------------------------------------- settings

func TestParseUnpricedPolicy(t *testing.T) {
	cases := []struct {
		in      string
		want    UnpricedPolicy
		wantErr bool
	}{
		{"", PolicyReject, false}, // unset fails closed
		{"reject", PolicyReject, false},
		{"REJECT", PolicyReject, false},
		{"  fallback  ", PolicyFallback, false},
		{"free", PolicyFree, false},
		{"nonsense", "", true},
	}
	for _, tc := range cases {
		got, err := ParseUnpricedPolicy(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Fatalf("ParseUnpricedPolicy(%q) succeeded, want an error", tc.in)
			}
			continue
		}
		if err != nil {
			t.Fatalf("ParseUnpricedPolicy(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Fatalf("ParseUnpricedPolicy(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestSettingsValidate(t *testing.T) {
	if err := (Settings{UnpricedPolicy: PolicyFallback}).Validate(); err == nil {
		t.Fatal("a fallback policy with no prices must be rejected")
	}
	if err := (Settings{
		UnpricedPolicy: PolicyReject,
		Fallback:       FallbackPrice{InputPrice: -1},
	}).Validate(); err == nil {
		t.Fatal("negative fallback prices must be rejected")
	}
	if err := DefaultSettings().Validate(); err != nil {
		t.Fatalf("the default settings must be valid: %v", err)
	}
	if err := (Settings{
		UnpricedPolicy: PolicyFallback,
		Fallback:       FallbackPrice{OutputPrice: 2},
	}).Validate(); err != nil {
		t.Fatalf("a chargeable fallback must be valid: %v", err)
	}
}

func TestDefaultSettingsFailClosed(t *testing.T) {
	if got := DefaultSettings().UnpricedPolicy; got != PolicyReject {
		t.Fatalf("default policy = %q, want %q", got, PolicyReject)
	}
}

func TestSettingsOptionsRoundTrip(t *testing.T) {
	want := Settings{
		UnpricedPolicy: PolicyFallback,
		Fallback: FallbackPrice{
			InputPrice: 1.5, OutputPrice: 6, CachedPrice: 0.75, PerRequestPrice: 0.002,
		},
	}

	got := DefaultSettings().applyOptions(want.Options())
	if got != want {
		t.Fatalf("round trip = %+v, want %+v", got, want)
	}
}

func TestApplyOptionsIgnoresJunk(t *testing.T) {
	base := Settings{
		UnpricedPolicy: PolicyReject,
		Fallback:       FallbackPrice{InputPrice: 2},
	}

	got := base.applyOptions(map[string]string{
		OptUnpricedPolicy: "not-a-policy",
		OptFallbackInput:  "abc",
		OptFallbackOutput: "-5",
		OptFallbackCached: "", // unset must not clear the default
	})
	if got != base {
		t.Fatalf("invalid options changed the settings: %+v", got)
	}
}

func TestNormaliseFailsClosedOnUnknownPolicy(t *testing.T) {
	got := Settings{UnpricedPolicy: "whatever"}.normalise()
	if got.UnpricedPolicy != PolicyReject {
		t.Fatalf("policy = %q, want %q", got.UnpricedPolicy, PolicyReject)
	}
}

func TestUSDConversionRoundTrip(t *testing.T) {
	if got := ParseUSD(1.5); got != 1_500_000 {
		t.Fatalf("ParseUSD(1.5) = %d, want 1500000", got)
	}
	if got := FormatUSD(1_500_000); got != 1.5 {
		t.Fatalf("FormatUSD(1500000) = %v, want 1.5", got)
	}
}
