// Package logstream fans request activity out to connected consoles. It is
// deliberately in-process and lossy: a settled log row is already durable in
// Postgres by the time it gets here, so this is a notification channel, not a
// delivery guarantee.
//
// Two kinds of news travel over it. A settled row is history and is announced
// once. An in-flight call is a claim about right now, so the broker also keeps
// the current set: a console that connects mid-flight is handed it up front,
// because a request that started before the tab was opened would otherwise stay
// invisible for as long as it runs — which is exactly the request worth seeing.
package logstream

import (
	"sort"
	"sync"
	"sync/atomic"

	"github.com/faketoken/faketoken/internal/model"
)

const (
	// subscriberBuffer is how far a console may fall behind before it starts
	// missing events. Announcing a call when it starts, again when it is routed
	// and once more when it settles puts roughly three events on the wire where
	// there used to be one, hence the headroom over the original 64.
	subscriberBuffer = 192
	// maxSubscribers bounds the memory an unauthenticated flood could pin —
	// every browser tab holds one, and each holds a buffered channel.
	maxSubscribers = 128
	// maxLive bounds the in-flight table. Ordinary traffic cannot reach it: an
	// entry lives exactly as long as the request goroutine that owns it. This
	// only caps the damage should some future path forget to call Forget.
	maxLive = 8192
)

// State says where a call was in its life when the event was raised.
type State uint8

const (
	// StateLive is a call that is still running. It is raised repeatedly for
	// the same key as the call is routed and retried, so consumers upsert on
	// the key rather than appending.
	StateLive State = iota
	// StateSettled is the durable row, exactly as a reload would list it. It
	// retires whatever StateLive last said about the same key.
	StateSettled
)

// Event is one notification on a console feed.
type Event struct {
	State State
	// Key ties the live announcements of a call to the row that ends it. Empty
	// on a settled row that was never announced live — the fast rejections
	// never reach an upstream, and a console that only ever sees the finished
	// row has no placeholder to replace.
	Key string
	// Entry is the row. On StateLive everything the request has not produced
	// yet is zero — no id, no status code, no usage — and CreatedAt is when the
	// call started rather than when it settled.
	Entry *model.RequestLog
}

// Subscription is one console's feed. Events is closed when the subscription
// is cancelled, so a reader can simply range over it.
type Subscription struct {
	Events <-chan Event

	broker *Broker
	id     uint64
	events chan Event
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
	// live holds the calls that have been announced and not yet settled. The
	// stored entries are private copies and are never written to again once
	// they are in the map, so handing the pointers to a reader is safe.
	live map[string]*model.RequestLog
}

func New() *Broker {
	return &Broker{
		subs: make(map[uint64]*Subscription),
		live: make(map[string]*model.RequestLog),
	}
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
	events := make(chan Event, subscriberBuffer)
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
		// Closing under the same lock send holds guarantees no send is in
		// flight on a channel that is about to be closed.
		close(s.events)
	})
}

// Announce records a running call and tells the consoles about it. Called once
// when the call is about to reach an upstream and again whenever the channel or
// the attempt count changes, so the row a console draws names the upstream it
// is actually waiting on.
//
// The entry is copied because the caller keeps writing to its own for the rest
// of the request.
func (b *Broker) Announce(key string, entry *model.RequestLog) {
	if key == "" || entry == nil {
		return
	}
	snapshot := *entry

	b.mu.Lock()
	if _, known := b.live[key]; !known && len(b.live) >= maxLive {
		b.mu.Unlock()
		// Past the cap the call still gets its event; it simply will not be
		// replayed to a console that connects later.
		b.send(Event{State: StateLive, Key: key, Entry: &snapshot})
		return
	}
	b.live[key] = &snapshot
	b.mu.Unlock()

	b.send(Event{State: StateLive, Key: key, Entry: &snapshot})
}

// Forget drops a call from the live set without announcing anything.
//
// This is the cleanup for a call that ends without ever producing a row — the
// caller hung up while the relay was backing off between retries, say. Consoles
// find out at the next reconciliation rather than immediately, which is the
// right trade for a path that is both rare and, by definition, unobserved.
func (b *Broker) Forget(key string) {
	if key == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.live, key)
}

// Publish hands a settled row to every live subscriber and retires the live
// entry it replaces. Key is empty for a call that was never announced.
//
// Sends are non-blocking on purpose: this runs on the relay's settlement path,
// and one console that stopped reading must never be able to stall request
// logging — let alone the request itself. A consumer that cannot keep up loses
// events and is told how many.
func (b *Broker) Publish(key string, entry *model.RequestLog) {
	if entry == nil {
		return
	}
	if key != "" {
		b.Forget(key)
	}
	b.send(Event{State: StateSettled, Key: key, Entry: entry})
}

func (b *Broker) send(event Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()

	for _, sub := range b.subs {
		select {
		case sub.events <- event:
		default:
			sub.dropped.Add(1)
		}
	}
}

// Snapshot returns the calls currently in flight, oldest first, so a console
// that has just connected can draw them in the order it would have received
// them.
//
// It is also what a connected console reconciles against: a placeholder whose
// key is no longer here is over, however its settled event was lost.
func (b *Broker) Snapshot() []Event {
	b.mu.RLock()
	events := make([]Event, 0, len(b.live))
	for key, entry := range b.live {
		events = append(events, Event{State: StateLive, Key: key, Entry: entry})
	}
	b.mu.RUnlock()

	sort.Slice(events, func(i, j int) bool {
		return events[i].Entry.CreatedAt.Before(events[j].Entry.CreatedAt)
	})
	return events
}

// LiveCount reports how many calls are in flight, for diagnostics.
func (b *Broker) LiveCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.live)
}

// Subscribers reports the number of live feeds, for diagnostics.
func (b *Broker) Subscribers() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}
