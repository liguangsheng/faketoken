package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
)

// Balance is what an aggregator reports about the credit behind a channel.
// Every amount is USD; a nil field means the upstream did not report it.
type Balance struct {
	OK        bool     `json:"ok"`
	Provider  string   `json:"provider"`
	Total     *float64 `json:"total_usd"`
	Used      *float64 `json:"used_usd"`
	Remaining *float64 `json:"remaining_usd"`
	Currency  string   `json:"currency"`
	PlanName  string   `json:"plan_name,omitempty"`
	Message   string   `json:"message,omitempty"`
}

// FetchBalance is kept as a compatibility alias for the original route, which
// now has the unambiguous new-api meaning.
func (rl *Relay) FetchBalance(ctx context.Context, ch *model.Channel) Balance {
	return rl.FetchNewAPIBalance(ctx, ch)
}

func (rl *Relay) FetchNewAPIBalance(ctx context.Context, ch *model.Channel) Balance {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if balance, ok := rl.newAPIBalance(ctx, ch); ok {
		return balance
	}
	return Balance{Provider: "new-api", Message: "the upstream did not expose new-api billing endpoints"}
}

func (rl *Relay) FetchSub2APIBalance(ctx context.Context, ch *model.Channel) Balance {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	if balance, ok := rl.sub2APIBalance(ctx, ch); ok {
		return balance
	}
	return Balance{Provider: "sub2api", Message: "the upstream did not expose a sub2api usage endpoint"}
}

// newAPIBalance reads the OpenAI-shaped dashboard endpoints that new-api and
// one-api expose. The subscription call carries the grant, the usage call the
// spend; the latter is best effort because a channel that only reports its
// remaining credit is still worth showing.
func (rl *Relay) newAPIBalance(ctx context.Context, ch *model.Channel) (Balance, bool) {
	subscription, ok := rl.billingJSON(ctx, ch, "/dashboard/billing/subscription", "")
	if !ok {
		return Balance{}, false
	}

	total := firstNumber(subscription, []string{"hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"})

	var used *float64
	if usage, ok := rl.billingJSON(ctx, ch, "/dashboard/billing/usage",
		"start_date=2020-01-01&end_date=2099-12-31"); ok {
		// new-api reports usage in cents while the subscription is in dollars.
		if cents := firstNumber(usage, []string{"total_usage"}); cents != nil {
			converted := *cents / 100
			used = &converted
		}
	}

	remaining := firstNumber(subscription, []string{"total_available", "remain_quota", "remaining", "balance"})
	if remaining == nil && total != nil && used != nil {
		left := *total - *used
		remaining = &left
	}
	if total == nil && remaining == nil {
		return Balance{}, false
	}

	return Balance{
		OK: true, Provider: "new-api", Currency: "USD",
		Total: total, Used: used, Remaining: remaining,
	}, true
}

// sub2APIBalance reads the sub2api usage endpoint, whose amounts hide at
// several nesting depths and are sometimes encoded as strings.
func (rl *Relay) sub2APIBalance(ctx context.Context, ch *model.Channel) (Balance, bool) {
	payload, ok := rl.billingJSON(ctx, ch, "/usage", "")
	if !ok {
		return Balance{}, false
	}

	remaining := numberAt(payload, [][]string{
		{"remaining"}, {"balance"}, {"quota", "remaining"}, {"quota", "balance"},
	})
	used := numberAt(payload, [][]string{
		{"usage", "total", "actual_cost"}, {"usage", "total", "cost"},
		{"total_actual_cost"}, {"total_cost"}, {"used"},
	})
	total := numberAt(payload, [][]string{{"total"}, {"quota", "total"}, {"limit"}})
	if remaining == nil && used == nil && total == nil {
		return Balance{}, false
	}

	currency := "USD"
	if unit := stringAt(payload, [][]string{{"unit"}, {"quota", "unit"}}); unit != "" {
		currency = unit
	}
	return Balance{
		OK: true, Provider: "sub2api", Currency: currency,
		Total: total, Used: used, Remaining: remaining,
		PlanName: stringAt(payload, [][]string{{"planName"}, {"plan_name"}, {"plan"}}),
	}, true
}

// billingJSON performs one authenticated GET and decodes a JSON object,
// reporting false for anything that is not a 2xx JSON object.
func (rl *Relay) billingJSON(ctx context.Context, ch *model.Channel, path, query string) (map[string]any, bool) {
	target := provider.JoinURL(ch.BaseURL, path)
	if query != "" {
		target += "?" + query
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, false
	}
	provider.ApplyAuth(req, ch.APIKey, ch.AuthStyle)
	for k, v := range ch.Headers {
		req.Header.Set(k, v)
	}

	client, err := rl.clients.Get(ch.ProxyURL)
	if err != nil {
		return nil, false
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, false
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil || resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, false
	}

	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, false
	}
	return payload, true
}

func firstNumber(payload map[string]any, keys []string) *float64 {
	paths := make([][]string, 0, len(keys))
	for _, key := range keys {
		paths = append(paths, []string{key})
	}
	return numberAt(payload, paths)
}

// numberAt returns the first path holding a number, tolerating the numeric
// strings some gateways emit.
func numberAt(payload map[string]any, paths [][]string) *float64 {
	for _, path := range paths {
		switch value := valueAt(payload, path).(type) {
		case float64:
			found := value
			return &found
		case string:
			if parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
				return &parsed
			}
		}
	}
	return nil
}

func stringAt(payload map[string]any, paths [][]string) string {
	for _, path := range paths {
		if text, ok := valueAt(payload, path).(string); ok {
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				return trimmed
			}
		}
	}
	return ""
}

func valueAt(payload map[string]any, path []string) any {
	var current any = payload
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			return nil
		}
		current = object[key]
	}
	return current
}

// FormatBalance renders a short human summary for logs.
func FormatBalance(b Balance) string {
	if !b.OK {
		return b.Message
	}
	if b.Remaining != nil {
		return fmt.Sprintf("%s %.2f remaining", b.Currency, *b.Remaining)
	}
	return b.Provider + " reported a balance"
}
