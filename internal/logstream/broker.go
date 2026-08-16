// Package logstream fans freshly written request logs out to connected
// consoles. It is deliberately in-process and lossy: a log row is already
// durable in Postgres by the time it gets here, so this is a notification
// channel, not a delivery guarantee.
package logstream

import (
	"sync"
	"sync/atomic"

	"github.com/faketoken/faketoken/internal/model"
)

const (
	// subscriberBuffer is how far a console may fall behind before it starts
	// missing events. A few seconds of burst at any realistic request rate.
	subscriberBuffer = 64
	// maxSubscribers bounds the memory an unauthenticated flood could pin —
	// every browser tab holds one, and each holds a buffered channel.
	maxSubscribers = 128
)

// Subscription is one console's feed. Events is closed when the subscription
// is cancelled, so a reader can simply range over it.
type Subscription struct {
	Events <-chan *model.RequestLog

	broker *Broker
	id     uint64
	events chan *model.RequestLog
	// dropped counts events skipped because this consumer fell behind. The
	// console is told rather than being left to assume the feed was complete.
	dropped atomic.Int64
	closed  sync.Once
}

// Dropped reports how many events this consumer missed by falling behind.
func (s *Subscription) Dropped() int64 { return s.dropped.Load() }

type Broker struct {
	mu     sync.RWMutex
	nextID uint64
	subs   map[uint64]*Subscription
}

func New() *Broker {
	return &Broker{subs: make(map[uint64]*Subscription)}
}

// Subscribe registers a consumer. The second return value is false when the
// server is already carrying its maximum number of feeds.
func (b *Broker) Subscribe() (*Subscription, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()

	if len(b.subs) >= maxSubscribers {
		return nil, false
	}
	b.nextID++
	events := make(chan *model.RequestLog, subscriberBuffer)
	sub := &Subscription{
		Events: events,
		broker: b,
		id:     b.nextID,
		events: events,
	}
	b.subs[sub.id] = sub
	return sub, true
}

// Close detaches the subscription. Idempotent, because the handler closes it
// on every exit path and a double close would panic on the channel.
func (s *Subscription) Close() {
	if s == nil {
		return
	}
	s.closed.Do(func() {
		s.broker.mu.Lock()
		defer s.broker.mu.Unlock()

		delete(s.broker.subs, s.id)
		// Closing under the same lock Publish holds guarantees no send is in
		// flight on a channel that is about to be closed.
		close(s.events)
	})
}

// Publish hands an entry to every live subscriber.
//
// Sends are non-blocking on purpose: this runs on the relay's settlement path,
// and one console that stopped reading must never be able to stall request
// logging — let alone the request itself. A consumer that cannot keep up loses
// events and is told how many.
func (b *Broker) Publish(entry *model.RequestLog) {
	if entry == nil {
		return
	}
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, sub := range b.subs {
		select {
		case sub.events <- entry:
		default:
			sub.dropped.Add(1)
		}
	}
}

// Subscribers reports the number of live feeds, for diagnostics.
func (b *Broker) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
