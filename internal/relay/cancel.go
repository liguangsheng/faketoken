package relay

import (
	"context"
	"errors"
	"sync"
)

// ErrCancelledByOperator is the cause attached when an administrator aborts a
// running call from the console.
//
// It exists because the request goroutine cannot otherwise tell the two ways a
// call dies apart: an operator pressing cancel and a caller hanging up both
// arrive as a cancelled context. The log row is the only place that difference
// survives, and "客户端断开" against a call somebody deliberately killed sends
// the next reader looking at the wrong end of the system.
var ErrCancelledByOperator = errors.New("cancelled by an administrator")

// liveCancels maps a call's live key — the same handle the consoles draw their
// in-flight rows against — to the func that aborts it.
//
// An entry lives exactly as long as the request goroutine that registered it:
// ServeHTTP drops it on every exit path. Nothing else may keep the func, since
// calling it after the request has settled would cancel nothing while pinning
// the entry forever.
type liveCancels struct {
	mu sync.Mutex
	fn map[string]context.CancelCauseFunc
}

func newLiveCancels() *liveCancels {
	return &liveCancels{fn: make(map[string]context.CancelCauseFunc)}
}

func (c *liveCancels) add(key string, cancel context.CancelCauseFunc) {
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.fn[key] = cancel
}

func (c *liveCancels) drop(key string) {
	if key == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.fn, key)
}

// cancel aborts the call and reports whether there was still one to abort.
//
// False is the ordinary outcome of a race, not a fault: a call can settle
// between the console drawing the button and the click arriving.
//
// The entry is not deleted here. The request goroutine owns its own
// registration and removes it as it unwinds, so deleting from this side would
// only open a window where a second press finds nothing and reports a failure
// for a call that is, at that moment, still running.
func (c *liveCancels) cancel(key string) bool {
	if key == "" {
		return false
	}
	c.mu.Lock()
	fn, ok := c.fn[key]
	c.mu.Unlock()

	if !ok {
		return false
	}
	fn(ErrCancelledByOperator)
	return true
}
