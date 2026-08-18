package relay

import (
	"sync"
	"time"
)

// rpmLimiter enforces a per-channel requests-per-minute cap using a sliding
// window. A channel with rpm_limit == 0 is never limited.
type rpmLimiter struct {
	mu   sync.Mutex
	hits map[int64][]time.Time
}

func newRPMLimiter() *rpmLimiter {
	return &rpmLimiter{hits: map[int64][]time.Time{}}
}

// allow reports whether channel id may proceed. When the limit is exceeded it
// also returns how long the caller should wait before retrying.
func (rl *rpmLimiter) allow(id int64, limit int32) (ok bool, retryAfter time.Duration) {
	if limit <= 0 {
		return true, 0
	}
	now := time.Now()
	windowStart := now.Add(-time.Minute)

	rl.mu.Lock()
	defer rl.mu.Unlock()

	hits := rl.hits[id]
	// Drop entries outside the sliding window.
	cutoff := 0
	for cutoff < len(hits) && hits[cutoff].Before(windowStart) {
		cutoff++
	}
	if cutoff > 0 {
		hits = hits[cutoff:]
	}

	if int32(len(hits)) >= limit {
		oldest := hits[0]
		rl.hits[id] = hits
		return false, oldest.Add(time.Minute).Sub(now)
	}

	hits = append(hits, now)
	rl.hits[id] = hits
	return true, 0
}

// release removes the channel's tracking state, called on breaker success to
// keep memory bounded for channels that have recovered.
func (rl *rpmLimiter) release(id int64) {
	rl.mu.Lock()
	delete(rl.hits, id)
	rl.mu.Unlock()
}
