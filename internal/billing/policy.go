package billing

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// Option keys persist billing behaviour in the options table so an operator can
// change it from the console without redeploying.
const (
	OptUnpricedPolicy  = "billing.unpriced_policy"
	OptFallbackInput   = "billing.fallback_input_price"
	OptFallbackOutput  = "billing.fallback_output_price"
	OptFallbackCached  = "billing.fallback_cached_price"
	OptFallbackRequest = "billing.fallback_per_request_price"
)

// fallbackModel is the synthetic name reported for prices that came from the
// fallback rate rather than from a real model_prices row.
const fallbackModel = "(fallback)"

// UnpricedPolicy decides what happens to a model that has no price entry.
//
// The dangerous default would be to relay it for free: usage is real money to
// the operator, so an unpriced model is a misconfiguration, not a discount.
type UnpricedPolicy string

const (
	// PolicyReject refuses the request instead of relaying it unbilled.
	PolicyReject UnpricedPolicy = "reject"
	// PolicyFallback relays the request and bills it at the fallback rate.
	PolicyFallback UnpricedPolicy = "fallback"
	// PolicyFree relays and records the request at zero cost. This is the old
	// behaviour, kept for operators who deliberately run a free gateway.
	PolicyFree UnpricedPolicy = "free"
)

// ParseUnpricedPolicy validates operator input, empty meaning "use the default".
func ParseUnpricedPolicy(s string) (UnpricedPolicy, error) {
	switch UnpricedPolicy(strings.ToLower(strings.TrimSpace(s))) {
	case "":
		return PolicyReject, nil
	case PolicyReject:
		return PolicyReject, nil
	case PolicyFallback:
		return PolicyFallback, nil
	case PolicyFree:
		return PolicyFree, nil
	default:
		return "", fmt.Errorf("unknown unpriced-model policy %q (want reject, fallback or free)", s)
	}
}

// FallbackPrice is the rate applied to models with no entry of their own, in
// USD per 1M tokens, matching model_prices.
type FallbackPrice struct {
	InputPrice      float64 `json:"input_price"`
	OutputPrice     float64 `json:"output_price"`
	CachedPrice     float64 `json:"cached_price"`
	PerRequestPrice float64 `json:"per_request_price"`
}

// Chargeable reports whether the fallback would actually bill anything. An
// all-zero fallback is indistinguishable from giving the model away.
func (f FallbackPrice) Chargeable() bool {
	return f.InputPrice > 0 || f.OutputPrice > 0 || f.CachedPrice > 0 || f.PerRequestPrice > 0
}

func (f FallbackPrice) negative() bool {
	return f.InputPrice < 0 || f.OutputPrice < 0 || f.CachedPrice < 0 || f.PerRequestPrice < 0
}

func (f FallbackPrice) price() *model.ModelPrice {
	return &model.ModelPrice{
		Model:           fallbackModel,
		InputPrice:      f.InputPrice,
		OutputPrice:     f.OutputPrice,
		CachedPrice:     f.CachedPrice,
		PerRequestPrice: f.PerRequestPrice,
	}
}

// Settings is the billing behaviour in force: environment values at boot,
// overlaid with whatever the console has stored since.
type Settings struct {
	UnpricedPolicy UnpricedPolicy `json:"unpriced_policy"`
	Fallback       FallbackPrice  `json:"fallback"`
}

// DefaultSettings fails closed: nothing is relayed until it has a price.
func DefaultSettings() Settings {
	return Settings{UnpricedPolicy: PolicyReject}
}

func (s Settings) Validate() error {
	if _, err := ParseUnpricedPolicy(string(s.UnpricedPolicy)); err != nil {
		return err
	}
	if s.Fallback.negative() {
		return errors.New("fallback prices cannot be negative")
	}
	if s.UnpricedPolicy == PolicyFallback && !s.Fallback.Chargeable() {
		return errors.New("the fallback policy needs at least one non-zero fallback price, " +
			"otherwise unpriced models are still relayed for free")
	}
	return nil
}

// normalise repairs a Settings that came from an untrusted source so the pricer
// never has to reason about invalid values on the hot path.
func (s Settings) normalise() Settings {
	policy, err := ParseUnpricedPolicy(string(s.UnpricedPolicy))
	if err != nil {
		slog.Warn("unknown unpriced-model policy, failing closed", "value", s.UnpricedPolicy)
		policy = PolicyReject
	}
	s.UnpricedPolicy = policy

	s.Fallback.InputPrice = max(s.Fallback.InputPrice, 0)
	s.Fallback.OutputPrice = max(s.Fallback.OutputPrice, 0)
	s.Fallback.CachedPrice = max(s.Fallback.CachedPrice, 0)
	s.Fallback.PerRequestPrice = max(s.Fallback.PerRequestPrice, 0)

	// A fallback policy with nothing to charge is the free policy wearing a
	// disguise; say so out loud rather than leaking revenue quietly.
	if s.UnpricedPolicy == PolicyFallback && !s.Fallback.Chargeable() {
		slog.Warn("fallback billing policy has no non-zero price; unpriced models would be free")
	}
	return s
}

// applyOptions overlays console overrides on top of the environment defaults.
// Unparseable values are ignored so a bad row cannot take billing down.
func (s Settings) applyOptions(opts map[string]string) Settings {
	if raw, ok := opts[OptUnpricedPolicy]; ok && strings.TrimSpace(raw) != "" {
		policy, err := ParseUnpricedPolicy(raw)
		if err != nil {
			slog.Warn("ignoring invalid unpriced-model policy from options", "value", raw)
		} else {
			s.UnpricedPolicy = policy
		}
	}
	s.Fallback.InputPrice = optFloat(opts, OptFallbackInput, s.Fallback.InputPrice)
	s.Fallback.OutputPrice = optFloat(opts, OptFallbackOutput, s.Fallback.OutputPrice)
	s.Fallback.CachedPrice = optFloat(opts, OptFallbackCached, s.Fallback.CachedPrice)
	s.Fallback.PerRequestPrice = optFloat(opts, OptFallbackRequest, s.Fallback.PerRequestPrice)
	return s
}

// Options renders the settings for persistence in the options table.
func (s Settings) Options() map[string]string {
	return map[string]string{
		OptUnpricedPolicy:  string(s.UnpricedPolicy),
		OptFallbackInput:   formatFloat(s.Fallback.InputPrice),
		OptFallbackOutput:  formatFloat(s.Fallback.OutputPrice),
		OptFallbackCached:  formatFloat(s.Fallback.CachedPrice),
		OptFallbackRequest: formatFloat(s.Fallback.PerRequestPrice),
	}
}

func optFloat(opts map[string]string, key string, def float64) float64 {
	raw, ok := opts[key]
	if !ok || strings.TrimSpace(raw) == "" {
		return def
	}
	v, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || v < 0 {
		slog.Warn("ignoring invalid billing option", "key", key, "value", raw)
		return def
	}
	return v
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
