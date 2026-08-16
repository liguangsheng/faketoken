package relay

import (
	"net/http"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

func TestOrderRespectsPriorityTiers(t *testing.T) {
	candidates := []model.Candidate{
		{ChannelID: 1, Priority: 0, Weight: 1},
		{ChannelID: 2, Priority: 10, Weight: 1},
		{ChannelID: 3, Priority: 5, Weight: 1},
		{ChannelID: 4, Priority: 10, Weight: 1},
	}

	for i := 0; i < 50; i++ {
		got := order(candidates)
		if len(got) != len(candidates) {
			t.Fatalf("lost candidates: %d of %d", len(got), len(candidates))
		}
		// Priority 10 channels must both come before priority 5, then 0.
		if got[0].Priority != 10 || got[1].Priority != 10 {
			t.Fatalf("priority tier violated: %+v", got)
		}
		if got[2].ChannelID != 3 || got[3].ChannelID != 1 {
			t.Fatalf("lower tiers out of order: %+v", got)
		}
	}
}

func TestWeightedShuffleFavoursHeavierChannelsButKeepsAll(t *testing.T) {
	tier := []model.Candidate{
		{ChannelID: 1, Priority: 0, Weight: 9},
		{ChannelID: 2, Priority: 0, Weight: 1},
	}

	firstWins := 0
	const runs = 2000
	for i := 0; i < runs; i++ {
		got := weightedShuffle(tier)
		if len(got) != 2 {
			t.Fatalf("expected every candidate to remain available, got %d", len(got))
		}
		if got[0].ChannelID == 1 {
			firstWins++
		}
	}

	ratio := float64(firstWins) / runs
	if ratio < 0.8 || ratio > 0.97 {
		t.Fatalf("weight 9:1 should win ~90%% of draws, got %.2f", ratio)
	}
}

func TestBreakerCooldownAndRecovery(t *testing.T) {
	b := newBreaker()
	if b.tripped(1) {
		t.Fatal("a fresh channel must not be tripped")
	}
	b.fail(1, 0)
	if !b.tripped(1) {
		t.Fatal("a failed channel must enter cooldown")
	}
	b.succeed(1)
	if b.tripped(1) {
		t.Fatal("success must clear the cooldown")
	}
}

func TestBreakerHonoursRetryAfter(t *testing.T) {
	b := newBreaker()
	// A first failure would normally cool down for 10s; the upstream asked for
	// longer, and only it knows when its window reopens.
	b.fail(1, time.Minute)

	b.mu.RLock()
	until := b.until[1]
	b.mu.RUnlock()

	if wait := time.Until(until); wait < 50*time.Second {
		t.Fatalf("Retry-After ignored: cooldown is %s", wait)
	}
}

func TestBreakerCapsRetryAfter(t *testing.T) {
	b := newBreaker()
	// An upstream asking for an hour must not bench the channel for an hour.
	b.fail(1, time.Hour)

	b.mu.RLock()
	until := b.until[1]
	b.mu.RUnlock()

	if wait := time.Until(until); wait > breakerMaxCooldown {
		t.Fatalf("cooldown %s exceeds the cap %s", wait, breakerMaxCooldown)
	}
}

func TestParseRetryAfter(t *testing.T) {
	tests := []struct {
		name  string
		value string
		want  time.Duration
	}{
		{"seconds", "30", 30 * time.Second},
		{"zero", "0", 0},
		{"negative", "-5", 0},
		{"absent", "", 0},
		{"garbage", "soon", 0},
		{"past date", "Mon, 02 Jan 2006 15:04:05 GMT", 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			if tc.value != "" {
				h.Set("Retry-After", tc.value)
			}
			if got := parseRetryAfter(h); got != tc.want {
				t.Fatalf("parseRetryAfter(%q) = %s, want %s", tc.value, got, tc.want)
			}
		})
	}

	// A future HTTP date must survive as a positive delay.
	h := http.Header{}
	h.Set("Retry-After", time.Now().Add(2*time.Minute).UTC().Format(http.TimeFormat))
	if got := parseRetryAfter(h); got < time.Minute {
		t.Fatalf("future date parsed as %s", got)
	}
}
