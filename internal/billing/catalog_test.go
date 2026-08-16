package billing

import (
	"strings"
	"testing"
)

// The catalogue is generated, so these tests guard the generator's output
// rather than hand-written data: a bad regeneration should fail the build, not
// quietly ship a table that bills nothing.

func TestCatalogIsWellFormed(t *testing.T) {
	entries := Catalog()
	if len(entries) < 100 {
		t.Fatalf("catalogue holds %d models, expected a substantial table; "+
			"regenerate with `make prices`", len(entries))
	}

	seen := make(map[string]bool, len(entries))
	for _, price := range entries {
		name := strings.TrimSpace(price.Model)
		if name == "" {
			t.Error("catalogue contains an entry with no model name")
			continue
		}
		// Lookup lower-cases its key, so two entries differing only in case
		// would shadow each other at runtime.
		key := strings.ToLower(name)
		if seen[key] {
			t.Errorf("duplicate catalogue entry for %q", name)
		}
		seen[key] = true

		if price.InputPrice < 0 || price.OutputPrice < 0 || price.CachedPrice < 0 {
			t.Errorf("%s has a negative price: %+v", name, price)
		}
		if price.InputPrice > 1000 || price.OutputPrice > 1000 {
			t.Errorf("%s looks mis-scaled (prices are USD per 1M tokens): %+v", name, price)
		}
	}
}

func TestCatalogCoversTheMajorFamilies(t *testing.T) {
	prices := Catalog()
	pricer := testPricer(DefaultSettings(), prices...)

	// Names a client would realistically send, including unlisted dated
	// snapshots that have to fall back to their family prefix.
	for _, name := range []string{
		"gpt-4o",
		"gpt-4o-mini",
		"gpt-5",
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20991231",
		"claude-opus-4-5",
		"gemini-2.5-pro",
		"gemini-2.5-pro-preview-99-99",
		"gemini-2.5-flash",
		"deepseek-chat",
		"grok-4.6",
		"qwen-plus",
		"kimi-k2.5",
		"glm-4.6",
	} {
		price, status := pricer.Resolve(name)
		if status != PriceExact {
			t.Errorf("%s is unpriced by the built-in catalogue (status %s)", name, status)
			continue
		}
		if price.InputPrice == 0 && price.OutputPrice == 0 {
			t.Errorf("%s resolved to a free price: %+v", name, price)
		}
	}
}

func TestCatalogMetadataIsStamped(t *testing.T) {
	if CatalogSource == "" {
		t.Error("CatalogSource is empty")
	}
	if len(CatalogGeneratedAt) != len("2006-01-02") {
		t.Errorf("CatalogGeneratedAt = %q, want a YYYY-MM-DD stamp", CatalogGeneratedAt)
	}
	if CatalogSize() != len(Catalog()) {
		t.Errorf("CatalogSize() = %d, len(Catalog()) = %d", CatalogSize(), len(Catalog()))
	}
}
