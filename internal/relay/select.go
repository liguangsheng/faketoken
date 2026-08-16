package relay

import (
	"math/rand"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// parseRetryAfter reads RFC 9110 Retry-After in both of its forms: a delay in
// seconds, or an absolute HTTP date. Anything else, including a date already in
// the past, means "no usable hint".
func parseRetryAfter(h http.Header) time.Duration {
	raw := strings.TrimSpace(h.Get("Retry-After"))
	if raw == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		if seconds <= 0 {
			return 0
		}
		return time.Duration(seconds) * time.Second
	}
	if at, err := http.ParseTime(raw); err == nil {
		if wait := time.Until(at); wait > 0 {
			return wait
		}
	}
	return 0
}

// order sorts candidates into the sequence they should be attempted in:
// strictly by descending priority, and weighted-random inside each tier.
func order(candidates []model.Candidate) []model.Candidate {
	if len(candidates) < 2 {
		return candidates
	}
	sorted := make([]model.Candidate, len(candidates))
	copy(sorted, candidates)
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].Priority > sorted[j].Priority
	})

	out := make([]model.Candidate, 0, len(sorted))
	for start := 0; start < len(sorted); {
		end := start
		for end < len(sorted) && sorted[end].Priority == sorted[start].Priority {
			end++
		}
		out = append(out, weightedShuffle(sorted[start:end])...)
		start = end
	}
	return out
}

// weightedShuffle draws candidates without replacement, each draw biased by
// weight. A channel with weight 3 is picked first three times as often as one
// with weight 1, and every channel still appears exactly once so retries can
// walk the whole tier.
func weightedShuffle(tier []model.Candidate) []model.Candidate {
	pool := make([]model.Candidate, len(tier))
	copy(pool, tier)

	out := make([]model.Candidate, 0, len(pool))
	for len(pool) > 0 {
		total := 0
		for _, c := range pool {
			total += weightOf(c)
		}
		pick := rand.Intn(total)
		idx := 0
		for i, c := range pool {
			pick -= weightOf(c)
			if pick < 0 {
				idx = i
				break
			}
		}
		out = append(out, pool[idx])
		pool = append(pool[:idx], pool[idx+1:]...)
	}
	return out
}

func weightOf(c model.Candidate) int {
	if c.Weight < 1 {
		return 1
	}
	return int(c.Weight)
}

// breaker keeps recently failed channels out of rotation for a short while so
// a dead upstream does not soak up the retry budget of every request.
type breaker struct {
	mu    sync.RWMutex
	until map[int64]time.Time
	fails map[int64]int
}

func newBreaker() *breaker {
	return &breaker{until: map[int64]time.Time{}, fails: map[int64]int{}}
}

const (
	breakerBaseCooldown = 10 * time.Second
	breakerMaxCooldown  = 5 * time.Minute
)

func (b *breaker) tripped(id int64) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	until, ok := b.until[id]
	return ok && time.Now().Before(until)
}

// fail benches the channel and reports the consecutive failure count. The
// cooldown grows exponentially, unless the upstream told us exactly how long to
// wait via Retry-After — only it knows when its own window reopens.
func (b *breaker) fail(id int64, retryAfter time.Duration) int {
	b.mu.Lock()
	defer b.mu.Unlock()

	b.fails[id]++
	n := b.fails[id]
	cooldown := breakerBaseCooldown * time.Duration(1<<min(n-1, 5))
	if retryAfter > 0 {
		cooldown = retryAfter
	}
	if cooldown > breakerMaxCooldown {
		cooldown = breakerMaxCooldown
	}
	b.until[id] = time.Now().Add(cooldown)
	return n
}

func (b *breaker) succeed(id int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.until, id)
	delete(b.fails, id)
}

func (b *breaker) reset(id int64) { b.succeed(id) }
