package modelsdev

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"slices"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
)

func fixture(t *testing.T) []byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/feed.json")
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestParseKeepsFirstPartyPricedModels(t *testing.T) {
	cat, err := Parse(fixture(t))
	if err != nil {
		t.Fatal(err)
	}

	want := []model.ModelPrice{
		// Z.AI outranks Zhipu AI in the allow-list, so its rate wins.
		{Model: "glm-4.7", InputPrice: 0.6, OutputPrice: 2.2, CachedPrice: 0.11},
		{Model: "gpt-4o", InputPrice: 2.5, OutputPrice: 10, CachedPrice: 1.25},
		// An input-only rate is still billable.
		{Model: "text-embedding-3-small", InputPrice: 0.02},
	}
	if !reflect.DeepEqual(cat.Prices, want) {
		t.Fatalf("prices = %+v\nwant %+v", cat.Prices, want)
	}
	if cat.duplicates != 2 {
		t.Errorf("duplicates = %d, want 2 (zhipuai's glm-4.7 and meta's case-variant GPT-4O)", cat.duplicates)
	}
	if slices.ContainsFunc(cat.Prices, func(p model.ModelPrice) bool { return p.Model == "broken" }) {
		t.Error("a model with a negative rate was kept")
	}
}

func TestParseReportsMissingProviders(t *testing.T) {
	cat, err := Parse(fixture(t))
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(cat.Missing, "anthropic") {
		t.Errorf("anthropic is absent from the fixture but not reported: %v", cat.Missing)
	}
	for _, present := range []string{"openai", "zai", "zhipuai"} {
		if slices.Contains(cat.Missing, present) {
			t.Errorf("%s is in the fixture but reported missing", present)
		}
	}
	if slices.Contains(cat.Missing, "openrouter") {
		t.Error("an aggregator outside the allow-list was reported missing")
	}
}

// A model id whose first occurrence is upper-case must still collapse a
// later lower-case twin: the pricer lower-cases its keys, so two rows here
// would shadow each other at billing time. openai outranks anthropic, so its
// spelling wins.
func TestParseDeduplicatesCaseVariantsWhateverTheOrder(t *testing.T) {
	raw := []byte(`{
		"openai":{"models":{"GPT-4o":{"id":"GPT-4o","cost":{"input":1,"output":2}}}},
		"anthropic":{"models":{"gpt-4o":{"id":"gpt-4o","cost":{"input":9,"output":9}}}}
	}`)

	cat, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Prices) != 1 {
		t.Fatalf("prices = %+v, want a single row for the one model", cat.Prices)
	}
	if cat.Prices[0].Model != "GPT-4o" || cat.Prices[0].InputPrice != 1 {
		t.Errorf("kept %+v, want openai's GPT-4o at rate 1", cat.Prices[0])
	}
	if cat.duplicates != 1 {
		t.Errorf("duplicates = %d, want 1", cat.duplicates)
	}
}

func TestParseRefusesAnEmptyFeed(t *testing.T) {
	for name, raw := range map[string]string{
		"no providers":      `{}`,
		"no priced models":  `{"openai":{"models":{"x":{"id":"x"}}}}`,
		"unknown providers": `{"openrouter":{"models":{"x":{"id":"x","cost":{"input":1}}}}}`,
		"garbage":           `not json`,
	} {
		if _, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: parsed without error", name)
		}
	}
}

// A rate above the sanity cap means the feed's units changed under us
// (per-1K, per-token). Those rows are skipped; a wholesale unit change
// skips everything and dies in the empty-catalogue refusal instead of
// billing 1000×.
func TestParseSkipsMisScaledRates(t *testing.T) {
	raw := []byte(`{"openai":{"models":{
		"sane":       {"id":"sane","cost":{"input":5,"output":15}},
		"huge-input": {"id":"huge-input","cost":{"input":2500,"output":15}},
		"huge-cache": {"id":"huge-cache","cost":{"input":1,"output":2,"cache_read":9000}}
	}}}`)

	cat, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Prices) != 1 || cat.Prices[0].Model != "sane" {
		t.Fatalf("prices = %+v, want only the sane row", cat.Prices)
	}
}

func TestFetchParsesTheFeed(t *testing.T) {
	raw := fixture(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(raw)
	}))
	defer srv.Close()

	cat, err := Fetch(context.Background(), srv.Client(), srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if len(cat.Prices) != 3 {
		t.Fatalf("got %d prices, want 3", len(cat.Prices))
	}
}

func TestFetchRejectsNon200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	defer srv.Close()

	_, err := Fetch(context.Background(), srv.Client(), srv.URL)
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("err = %v, want an ErrUpstream wrap", err)
	}
}

// Malformed content is the upstream's fault too: the console answers 502 so
// the operator knows models.dev (or the mirror) is broken, not the gateway.
func TestFetchReportsUnusableContentAsUpstream(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("not json"))
	}))
	defer srv.Close()

	_, err := Fetch(context.Background(), srv.Client(), srv.URL)
	if !errors.Is(err, ErrUpstream) {
		t.Fatalf("err = %v, want an ErrUpstream wrap", err)
	}
}
