package modelsdev

import (
	"context"
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
	if cat.Duplicates != 1 {
		t.Errorf("duplicates = %d, want 1 (zhipuai's glm-4.7)", cat.Duplicates)
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

	if _, err := Fetch(context.Background(), srv.Client(), srv.URL); err == nil {
		t.Fatal("a 502 was accepted as a catalogue")
	}
}
