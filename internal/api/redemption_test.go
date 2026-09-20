package api

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
)

// createRedemptions generates a batch and returns the codes.
func (h *harness) createRedemptions(t *testing.T, amountUSD float64, count int) []string {
	t.Helper()
	var created struct {
		Data []model.Redemption `json:"data"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin,
		map[string]any{"name": "test", "amount_usd": amountUSD, "count": count}, &created)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated || len(created.Data) != count {
		t.Fatalf("create redemptions: HTTP %d with %d codes", resp.StatusCode, len(created.Data))
	}
	codes := make([]string, 0, count)
	for _, entry := range created.Data {
		codes = append(codes, entry.Code)
	}
	return codes
}

// A spent code is the only record that a balance was ever credited: there is
// no ledger behind it, so deleting one would leave money in an account with
// nothing to explain where it came from. It also frees the per-campaign slot,
// letting the same user claim a second code from the group.
func TestDeletingRedemptionsKeepsSpentOnes(t *testing.T) {
	h := newHarness(t)

	codes := h.createRedemptions(t, 1, 3)
	all := h.listRedemptions(t)
	if len(all) != 3 {
		t.Fatalf("expected 3 codes, got %d", len(all))
	}

	// Spend the first one.
	resp := h.do(http.MethodPost, "/api/redeem", h.admin, map[string]any{"code": codes[0]}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("redeem: HTTP %d", resp.StatusCode)
	}

	ids := make([]int64, 0, len(all))
	for _, entry := range all {
		ids = append(ids, entry.ID)
	}

	// Ask for all three, including the spent one.
	var result struct {
		Deleted int64 `json:"deleted"`
	}
	resp = h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": ids}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("delete: HTTP %d", resp.StatusCode)
	}
	if result.Deleted != 2 {
		t.Fatalf("deleted %d, want 2 — the spent code must be kept", result.Deleted)
	}

	remaining := h.listRedemptions(t)
	if len(remaining) != 1 {
		t.Fatalf("%d codes remain, want only the spent one", len(remaining))
	}
	kept := remaining[0]
	if kept.Code != codes[0] || kept.Status != model.RedemptionUsed {
		t.Fatalf("the wrong code survived: %+v", kept)
	}
	// The audit trail has to be intact, not merely the row.
	if kept.UsedByName == "" || kept.UsedAt == nil {
		t.Fatalf("the record of who was credited was lost: %+v", kept)
	}
}

// Deleting one code at a time is the same endpoint with a selection of one,
// which is what the row action in the console sends.
func TestDeletingASingleRedemption(t *testing.T) {
	h := newHarness(t)

	h.createRedemptions(t, 1, 2)
	all := h.listRedemptions(t)

	var result struct {
		Deleted int64 `json:"deleted"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": []int64{all[0].ID}}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK || result.Deleted != 1 {
		t.Fatalf("delete one: HTTP %d deleted %d", resp.StatusCode, result.Deleted)
	}
	if remaining := h.listRedemptions(t); len(remaining) != 1 {
		t.Fatalf("%d codes remain, want 1", len(remaining))
	}
}

// An empty selection is a mistake, not a request to delete nothing, and the
// message has to name what the caller was actually selecting.
func TestDeletingRedemptionsRejectsAnEmptySelection(t *testing.T) {
	h := newHarness(t)

	resp := h.do(http.MethodPost, "/api/admin/redemptions/delete", h.admin,
		map[string]any{"ids": []int64{}}, nil)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("empty selection: HTTP %d, want 400", resp.StatusCode)
	}
	if strings.Contains(string(body), "渠道") {
		t.Fatalf("the redemption endpoint reported a channel error: %s", body)
	}
}

func TestRedemptionCreditsTheUserOnce(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "spender", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "spender", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "spender")
	if err != nil {
		t.Fatal(err)
	}
	code := h.createRedemptions(t, 5, 1)[0]

	var result struct {
		Quota   int64 `json:"quota"`
		Balance int64 `json:"balance"`
	}
	resp := h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": code}, &result)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("redeem: HTTP %d", resp.StatusCode)
	}
	if result.Quota != billing.ParseUSD(5) {
		t.Fatalf("credited %d micro-USD, want %d", result.Quota, billing.ParseUSD(5))
	}
	if result.Balance != before.Quota+billing.ParseUSD(5) {
		t.Fatalf("balance = %d, want %d", result.Balance, before.Quota+billing.ParseUSD(5))
	}

	// Case and padding must not matter, but a spent code stays spent.
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "  " + strings.ToLower(code) + "  "}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("second redeem: HTTP %d, want 409", resp.StatusCode)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "spender")
	if err != nil {
		t.Fatal(err)
	}
	if after.Quota != before.Quota+billing.ParseUSD(5) {
		t.Fatalf("balance moved twice: %d", after.Quota)
	}
}

// The interesting failure mode: the same code submitted concurrently must
// credit exactly once, or a code becomes an unlimited money printer.
func TestConcurrentRedemptionCreditsExactlyOnce(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "racer", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "racer", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "racer")
	if err != nil {
		t.Fatal(err)
	}
	code := h.createRedemptions(t, 10, 1)[0]

	const attempts = 8
	var wg sync.WaitGroup
	statuses := make([]int, attempts)
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			resp := h.do(http.MethodPost, "/api/redeem", session.Token,
				map[string]any{"code": code}, nil)
			resp.Body.Close()
			// A slice, not a map, and each goroutine owns one index; the read
			// below happens after wg.Wait(). Verified under -race.
			// pi-lens-ignore: go-shared-map-write-goroutine
			statuses[i] = resp.StatusCode
		}(i)
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d of %d concurrent redemptions succeeded, want exactly 1", succeeded, attempts)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "racer")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := after.Quota-before.Quota, billing.ParseUSD(10); got != want {
		t.Fatalf("balance moved by %d micro-USD, want %d", got, want)
	}
}

// Two different codes from one group, submitted concurrently: the database
// index is what makes this safe, since checking the user's history first and
// claiming afterwards would let both through.
func TestGroupedRedemptionsAreOnePerUser(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "claimer", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "claimer", Password: "password123"}, &session)

	before, err := h.store.GetUserByUsername(context.Background(), "claimer")
	if err != nil {
		t.Fatal(err)
	}

	var created struct {
		Data []model.Redemption `json:"data"`
	}
	resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin, map[string]any{
		"group": "double-eleven", "amount_usd": 2, "count": 4,
	}, &created)
	resp.Body.Close()
	if len(created.Data) != 4 {
		t.Fatalf("generated %d codes", len(created.Data))
	}

	var wg sync.WaitGroup
	statuses := make([]int, len(created.Data))
	start := make(chan struct{})
	for i, entry := range created.Data {
		wg.Add(1)
		go func(i int, code string) {
			defer wg.Done()
			<-start
			resp := h.do(http.MethodPost, "/api/redeem", session.Token,
				map[string]any{"code": code}, nil)
			resp.Body.Close()
			// A slice, not a map, and each goroutine owns one index; the read
			// below happens after wg.Wait(). Verified under -race.
			// pi-lens-ignore: go-shared-map-write-goroutine
			statuses[i] = resp.StatusCode
		}(i, entry.Code)
	}
	close(start)
	wg.Wait()

	succeeded := 0
	for _, status := range statuses {
		if status == http.StatusOK {
			succeeded++
		}
	}
	if succeeded != 1 {
		t.Fatalf("%d of 4 grouped codes were claimed, want exactly 1 (%v)", succeeded, statuses)
	}

	after, err := h.store.GetUserByUsername(context.Background(), "claimer")
	if err != nil {
		t.Fatal(err)
	}
	if got, want := after.Quota-before.Quota, billing.ParseUSD(2); got != want {
		t.Fatalf("balance moved by %d, want %d", got, want)
	}

	// A later, unhurried attempt at the same group is refused too.
	remaining := ""
	for i, entry := range created.Data {
		if statuses[i] != http.StatusOK {
			remaining = entry.Code
			break
		}
	}
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": remaining}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("sequential second claim: HTTP %d, want 409", resp.StatusCode)
	}

	// A different user is unaffected, and ungrouped codes stay unrestricted.
	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "other", "password": "password123",
	}, nil)
	var otherSession sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "other", Password: "password123"}, &otherSession)
	resp = h.do(http.MethodPost, "/api/redeem", otherSession.Token,
		map[string]any{"code": remaining}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("a second user was blocked by someone else's claim: HTTP %d", resp.StatusCode)
	}

	loose := h.createRedemptions(t, 1, 2)
	for _, code := range loose {
		resp := h.do(http.MethodPost, "/api/redeem", session.Token,
			map[string]any{"code": code}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("ungrouped code was refused: HTTP %d", resp.StatusCode)
		}
	}
}

func TestRedemptionRejectsUnusableCodes(t *testing.T) {
	h := newHarness(t)

	h.do(http.MethodPost, "/api/admin/users", h.admin, map[string]any{
		"username": "picky", "password": "password123",
	}, nil)
	var session sessionResponse
	h.do(http.MethodPost, "/api/auth/login", "",
		credentials{Username: "picky", Password: "password123"}, &session)

	// Unknown.
	resp := h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "AAAAA-BBBBB-CCCCC-DDDDD"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown code: HTTP %d, want 404", resp.StatusCode)
	}

	// Disabled.
	codes := h.createRedemptions(t, 1, 1)
	listed := h.listRedemptions(t)
	resp = h.do(http.MethodPut,
		fmt.Sprintf("/api/admin/redemptions/%d/status", listed[0].ID), h.admin,
		map[string]any{"status": model.RedemptionDisabled}, nil)
	resp.Body.Close()

	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": codes[0]}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("disabled code: HTTP %d, want 403", resp.StatusCode)
	}

	// Expired: written straight to the store, since the API refuses to create
	// a code that is already in the past.
	past := time.Now().Add(-time.Hour)
	if _, err := h.store.CreateRedemptions(context.Background(), []*model.Redemption{{
		Code: "EXPIR-EDCOD-EEEEE-11111", Quota: billing.ParseUSD(1), ExpiresAt: &past,
	}}); err != nil {
		t.Fatal(err)
	}
	resp = h.do(http.MethodPost, "/api/redeem", session.Token,
		map[string]any{"code": "EXPIR-EDCOD-EEEEE-11111"}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("expired code: HTTP %d, want 403", resp.StatusCode)
	}

	// A regular user cannot mint credit.
	resp = h.do(http.MethodPost, "/api/admin/redemptions", session.Token,
		map[string]any{"amount_usd": 100, "count": 1}, nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("user minted codes: HTTP %d, want 403", resp.StatusCode)
	}

	// Zero or negative value is refused.
	for _, amount := range []float64{0, -5} {
		resp := h.do(http.MethodPost, "/api/admin/redemptions", h.admin,
			map[string]any{"amount_usd": amount, "count": 1}, nil)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("amount %v accepted: HTTP %d", amount, resp.StatusCode)
		}
	}
}

func (h *harness) listRedemptions(t *testing.T) []*model.Redemption {
	t.Helper()
	var listed page[*model.Redemption]
	h.do(http.MethodGet, "/api/admin/redemptions?page_size=100", h.admin, nil, &listed)
	return listed.Data
}
