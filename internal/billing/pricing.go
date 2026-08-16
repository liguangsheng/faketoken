// Package billing turns token usage into money.
//
// All monetary values are integers in micro-USD (1e-6 USD) to keep accounting
// exact. Prices are expressed as USD per 1M tokens, which makes the conversion
// pleasantly direct: cost_micro_usd = tokens * price_per_million_usd.
package billing

import (
	"context"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// MicroUSD is how many integer units make one US dollar.
const MicroUSD = 1_000_000

type Pricer struct {
	st *store.Store

	// defaults come from the environment and act as the floor under whatever
	// the console has stored in the options table.
	defaults Settings

	mu       sync.RWMutex
	prices   map[string]*model.ModelPrice
	groups   map[string]float64
	settings Settings
	loaded   time.Time
}

func NewPricer(st *store.Store, defaults Settings) *Pricer {
	defaults = defaults.normalise()
	return &Pricer{
		st:       st,
		defaults: defaults,
		settings: defaults,
		prices:   map[string]*model.ModelPrice{},
		groups:   map[string]float64{},
	}
}

func (p *Pricer) Reload(ctx context.Context) error {
	prices, err := p.st.ListPrices(ctx)
	if err != nil {
		return err
	}
	groups, err := p.st.ListUserGroups(ctx)
	if err != nil {
		return err
	}
	opts, err := p.st.AllOptions(ctx)
	if err != nil {
		return err
	}

	priceMap := make(map[string]*model.ModelPrice, len(prices))
	for _, pr := range prices {
		priceMap[strings.ToLower(pr.Model)] = pr
	}
	groupMap := make(map[string]float64, len(groups))
	for _, g := range groups {
		if g.Rate <= 0 {
			slog.Warn("user group has a non-positive billing rate; treating it as 1",
				"group", g.Name, "rate", g.Rate)
		}
		groupMap[g.Name] = g.Rate
	}

	p.mu.Lock()
	p.prices, p.groups, p.loaded = priceMap, groupMap, time.Now()
	p.settings = p.defaults.applyOptions(opts).normalise()
	p.mu.Unlock()
	return nil
}

// Settings returns the billing behaviour currently in force.
func (p *Pricer) Settings() Settings {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.settings
}

// StartRefresh keeps the in-memory price table warm without hitting Postgres
// on every relayed request.
func (p *Pricer) StartRefresh(ctx context.Context, every time.Duration) {
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := p.Reload(ctx); err != nil {
					slog.Warn("price reload failed", "error", err)
				}
			}
		}
	}()
}

// Lookup resolves a model name to its price, falling back to the longest
// registered prefix so that dated snapshots (gpt-4o-2024-11-20) inherit the
// price of their family (gpt-4o) without needing an entry each.
func (p *Pricer) Lookup(name string) (*model.ModelPrice, bool) {
	key := strings.ToLower(strings.TrimSpace(name))
	p.mu.RLock()
	defer p.mu.RUnlock()

	if pr, ok := p.prices[key]; ok {
		return pr, true
	}
	var best *model.ModelPrice
	bestLen := 0
	for candidate, pr := range p.prices {
		if len(candidate) > bestLen && strings.HasPrefix(key, candidate) {
			best, bestLen = pr, len(candidate)
		}
	}
	return best, best != nil
}

func (p *Pricer) GroupRate(group string) float64 {
	p.mu.RLock()
	defer p.mu.RUnlock()
	// A non-positive rate would silently zero every bill for the group, so it
	// is treated as unset — the same normalisation channel ratios get.
	if r, ok := p.groups[group]; ok && r > 0 {
		return r
	}
	return 1
}

// PriceStatus explains where a request's price came from, so callers can tell a
// model that is genuinely free from one nobody has priced yet.
type PriceStatus int

const (
	// PriceExact means a configured entry matched, directly or by prefix.
	PriceExact PriceStatus = iota
	// PriceFallback means the operator's default rate was applied.
	PriceFallback
	// PriceMissing means the request cannot be billed at all.
	PriceMissing
)

func (s PriceStatus) String() string {
	switch s {
	case PriceExact:
		return "exact"
	case PriceFallback:
		return "fallback"
	default:
		return "missing"
	}
}

// Resolve finds the rate to bill a model at, applying the fallback rate when the
// operator asked for one.
func (p *Pricer) Resolve(name string) (*model.ModelPrice, PriceStatus) {
	if price, ok := p.Lookup(name); ok {
		return price, PriceExact
	}
	settings := p.Settings()
	if settings.UnpricedPolicy == PolicyFallback && settings.Fallback.Chargeable() {
		return settings.Fallback.price(), PriceFallback
	}
	return nil, PriceMissing
}

// Blocked reports whether a model must be refused because it has no price and
// the operator chose to fail closed rather than give tokens away.
func (p *Pricer) Blocked(name string) bool {
	if _, status := p.Resolve(name); status != PriceMissing {
		return false
	}
	return p.Settings().UnpricedPolicy == PolicyReject
}

// Cost returns the price of one request in micro-USD. The status distinguishes a
// real zero from an unbillable request: callers must not treat them alike.
func (p *Pricer) Cost(modelName string, usage model.Usage, group string, channelRatio float64) (int64, PriceStatus) {
	price, status := p.Resolve(modelName)
	if status == PriceMissing {
		return 0, status
	}
	if channelRatio <= 0 {
		channelRatio = 1
	}

	cached := min(usage.CachedTokens, usage.PromptTokens)
	fresh := usage.PromptTokens - cached

	total := float64(fresh) * price.InputPrice
	total += float64(cached) * effectiveCachedPrice(price)
	total += float64(usage.CompletionTokens) * price.OutputPrice
	total += price.PerRequestPrice * MicroUSD

	total *= p.GroupRate(group) * channelRatio
	if total <= 0 {
		return 0, status
	}
	return int64(math.Round(total)), status
}

func effectiveCachedPrice(p *model.ModelPrice) float64 {
	if p.CachedPrice > 0 {
		return p.CachedPrice
	}
	return p.InputPrice
}

// FormatUSD renders a micro-USD amount for logs and API responses.
func FormatUSD(micro int64) float64 {
	return float64(micro) / MicroUSD
}

// ParseUSD converts a dollar amount into micro-USD.
func ParseUSD(usd float64) int64 {
	return int64(math.Round(usd * MicroUSD))
}
