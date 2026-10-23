package api

import (
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/relay"
)

// The password endpoints face the public internet, so wrong guesses are
// counted and, past a few, answered with a lockout.
//
// Counted per client IP and per username. The IP key slows one caller down;
// the username key still holds when the IPs vary — a botnet, or a caller that
// reaches the port directly and forges X-Forwarded-For. A locked key is
// refused before any password check, so a refused attempt neither burns a
// bcrypt nor gets to test a password.
const (
	// guardLockAfter is the failure that locks a key: four free mistakes.
	guardLockAfter = 5
	// The first lock lasts guardBaseLock and each failure after it doubles
	// that, up to guardMaxLock: 1, 2, 4, 8, then 15 minutes.
	guardBaseLock = time.Minute
	guardMaxLock  = 15 * time.Minute
	// guardForgetAfter clears a key after this long without a failure, so last
	// week's typos do not count against today's login.
	guardForgetAfter = time.Hour
)

// attemptGuard counts failed password attempts per key, in memory: a restart
// forgets them, which costs an attacker nothing they could not get by waiting.
type attemptGuard struct {
	mu    sync.Mutex
	keys  map[string]*attempts
	swept time.Time
	// now is replaced by tests to step through a lockout.
	now func() time.Time
}

type attempts struct {
	failures int
	last     time.Time // the most recent failure
	until    time.Time // locked until then; zero when never locked
}

func newAttemptGuard() *attemptGuard {
	return &attemptGuard{keys: map[string]*attempts{}, now: time.Now}
}

// wait reports how long key is still locked; zero means it may try.
func (g *attemptGuard) wait(key string) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()
	if a, ok := g.keys[key]; ok {
		return max(a.until.Sub(g.now()), 0)
	}
	return 0
}

// fail counts one failure against key and returns the lock it earned, zero
// while the key still has free mistakes left.
func (g *attemptGuard) fail(key string) time.Duration {
	g.mu.Lock()
	defer g.mu.Unlock()

	now := g.now()
	g.sweep(now)

	a, ok := g.keys[key]
	if !ok || now.Sub(a.last) > guardForgetAfter {
		a = &attempts{}
		g.keys[key] = a
	}
	a.failures++
	a.last = now
	if a.failures < guardLockAfter {
		return 0
	}

	// The shift is capped because 1<<4 minutes already passes the ceiling,
	// and an uncapped one overflows after enough failures.
	lock := min(guardBaseLock<<min(a.failures-guardLockAfter, 4), guardMaxLock)
	a.until = now.Add(lock)
	return lock
}

// succeed forgets key: whoever got past the password has proved they know it.
func (g *attemptGuard) succeed(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.keys, key)
}

// sweep drops keys that have gone quiet, at most once a minute. A spray of
// made-up usernames would otherwise grow the map without bound. Every lock
// ends well inside guardForgetAfter, so no live lock is dropped.
func (g *attemptGuard) sweep(now time.Time) {
	if now.Sub(g.swept) < time.Minute {
		return
	}
	g.swept = now
	for key, a := range g.keys {
		if now.Sub(a.last) > guardForgetAfter {
			delete(g.keys, key)
		}
	}
}

// ipGuardKey names the counter for the caller's address, read the same way the
// request log reads it.
func ipGuardKey(r *http.Request) string {
	return "ip:" + relay.ClientIP(r)
}

// userGuardKey folds case like the username lookup does, and is bounded: no
// real username passes 32 characters, and the key must not grow with whatever
// a caller sends.
func userGuardKey(username string) string {
	name := strings.ToLower(strings.TrimSpace(username))
	if len(name) > 64 {
		name = name[:64]
	}
	return "user:" + name
}

// throttled answers 429 when any of keys is locked, and reports whether it did.
func (s *Server) throttled(w http.ResponseWriter, keys ...string) bool {
	var wait time.Duration
	for _, key := range keys {
		wait = max(wait, s.guard.wait(key))
	}
	if wait <= 0 {
		return false
	}

	seconds := int(math.Ceil(wait.Seconds()))
	w.Header().Set("Retry-After", strconv.Itoa(seconds))
	fail(w, http.StatusTooManyRequests, fmt.Sprintf("尝试次数过多，请 %d 秒后再试", seconds))
	return true
}

// charge counts a failed attempt against every key and logs it, with the lock
// it earned. The log line is the only record of a guessing run.
func (s *Server) charge(what string, keys ...string) {
	var lock time.Duration
	for _, key := range keys {
		lock = max(lock, s.guard.fail(key))
	}
	slog.Warn(what, "keys", keys, "locked_for", lock)
}

// missHash is what an unknown username is checked against, so a miss costs the
// same bcrypt a wrong password does and the response time cannot tell the two
// apart. The error is ignored: it only fires for a password over 72 bytes.
var missHash = sync.OnceValue(func() string {
	hash, _ := auth.HashPassword("no account has this password")
	return hash
})
