package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/relay"
)

// The billing endpoints exist so another gateway can read the credit behind a
// key. The strongest check available is to point this gateway's own balance
// probe at itself: that probe is a new-api client, so parsing its own output
// is what compatibility means here.
func TestBillingEndpointsAreReadableByTheBalanceProbe(t *testing.T) {
	h := newHarness(t)

	// $10 of balance, with a key limited to $4 of it.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "holder", "password": "password123", "quota_usd": 10,
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "holder", Password: "password123"}, &session)

	var created struct {
		Key string `json:"key"`
	}
	resp := h.do(http.MethodPost, "/api/tokens", session.Token, tokenInput{
		Name: "limited", UnlimitedQuota: false, QuotaUSD: 4,
	}, &created)
	resp.Body.Close()

	// A channel pointing back at this very server, authenticated with that key.
	id := h.createChannel(channelInput{
		Name: "self", Type: "openai", BaseURL: h.server.URL, APIKey: created.Key,
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var balance relay.Balance
	resp = h.do(http.MethodPost, fmt.Sprintf("/api/admin/channels/%d/balance", id),
		h.admin, nil, &balance)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("balance: HTTP %d", resp.StatusCode)
	}
	if !balance.OK {
		t.Fatalf("the probe could not read our own billing endpoints: %+v", balance)
	}
	if balance.Provider != "new-api" {
		t.Fatalf("recognised as %q, want the new-api dialect", balance.Provider)
	}
	// The key allows $4 and the account holds $10, so $4 is what it can spend.
	if balance.Remaining == nil || *balance.Remaining != 4 {
		t.Fatalf("remaining = %v, want 4", balance.Remaining)
	}
}

func TestSub2APIBalanceUsesItsDedicatedEndpoint(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/usage" {
			http.NotFound(w, r)
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sub2-key" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"quota":    map[string]any{"remaining": "7.5", "total": 10, "unit": "USD"},
			"usage":    map[string]any{"total": map[string]any{"actual_cost": "2.5"}},
			"planName": "Pro",
		})
	})
	id := h.createChannel(channelInput{
		Name: "sub2api", BaseURL: up.URL, APIKey: "sub2-key",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})

	var balance relay.Balance
	resp := h.do(http.MethodPost,
		fmt.Sprintf("/api/admin/channels/%d/balance/sub2api", id), h.admin, nil, &balance)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || !balance.OK {
		t.Fatalf("HTTP %d, balance %+v", resp.StatusCode, balance)
	}
	if balance.Provider != "sub2api" || balance.PlanName != "Pro" {
		t.Fatalf("unexpected identity: %+v", balance)
	}
	if balance.Remaining == nil || *balance.Remaining != 7.5 ||
		balance.Used == nil || *balance.Used != 2.5 ||
		balance.Total == nil || *balance.Total != 10 {
		t.Fatalf("unexpected amounts: %+v", balance)
	}
}

// The two amounts use different units — dollars in one call, cents in the
// other — and getting that backwards is invisible until a caller reports a
// balance a hundred times too large.
func TestBillingUsageIsReportedInCents(t *testing.T) {
	h := newHarness(t)

	up := newUpstream(t, func(u *upstream, w http.ResponseWriter, r *http.Request) {
		chatResponse(w, "ok", 1000, 1000)
	})
	h.createChannel(channelInput{
		Name: "c", Type: "openai", BaseURL: up.URL, APIKey: "k",
		Models: []string{"gpt-4o"}, Groups: []string{"default"},
	})
	// Priced explicitly so the arithmetic below is not at the mercy of the
	// bundled catalogue: 1 micro-USD per token each way.
	h.do(http.MethodPost, "/api/admin/prices", h.admin,
		model.ModelPrice{Model: "gpt-4o", InputPrice: 1, OutputPrice: 1}, nil)

	key := h.createKey()
	relayed := h.relayRequest(http.MethodPost, "/v1/chat/completions", key, `{"model":"gpt-4o"}`)
	_, _ = io.Copy(io.Discard, relayed.Body)
	relayed.Body.Close()
	h.waitForLog(t, 1)

	req, err := http.NewRequest(http.MethodGet,
		h.server.URL+"/dashboard/billing/usage?start_date=2020-01-01&end_date=2099-12-31", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	var usage struct {
		Object     string  `json:"object"`
		TotalUsage float64 `json:"total_usage"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&usage)
	resp.Body.Close()

	// 1000 prompt + 1000 completion at $1 per million each is $0.002, so 0.2
	// cents. Anything reported in dollars here would come back as 0.002.
	if usage.TotalUsage < 0.19 || usage.TotalUsage > 0.21 {
		t.Fatalf("total_usage = %v cents, want ~0.2", usage.TotalUsage)
	}
}

// Without a key these say nothing: they report how much credit exists, which
// is not something an anonymous caller gets to ask.
func TestBillingEndpointsNeedAKey(t *testing.T) {
	h := newHarness(t)

	for _, path := range []string{
		"/dashboard/billing/subscription",
		"/dashboard/billing/usage",
	} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s without a key: HTTP %d, want 401", path, resp.StatusCode)
		}
	}
}
