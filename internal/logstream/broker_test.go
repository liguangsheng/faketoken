package logstream

import (
	"sync"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

func timeoutAfterSeconds(seconds int) <-chan time.Time {
	return time.After(time.Duration(seconds) * time.Second)
}

func TestPublishReachesEverySubscriber(t *testing.T) {
	broker := New()
	first, _ := broker.Subscribe()
	second, _ := broker.Subscribe()
	defer first.Close()
	defer second.Close()

	broker.Publish("", &model.RequestLog{ID: 7})

	for name, sub := range map[string]*Subscription{"first": first, "second": second} {
		select {
		case event := <-sub.Events:
			if event.Entry.ID != 7 {
				t.Fatalf("%s received id %d", name, event.Entry.ID)
			}
			if event.State != StateSettled {
				t.Fatalf("%s received state %v, want settled", name, event.State)
			}
		default:
			t.Fatalf("%s received nothing", name)
		}
	}
}

// A console that connects while calls are running has to be told about them:
// the whole point of the in-flight view is the request that is still going.
func TestSnapshotReplaysRunningCallsOldestFirst(t *testing.T) {
	broker := New()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	broker.Announce("second", &model.RequestLog{Model: "b", CreatedAt: base.Add(time.Second)})
	broker.Announce("first", &model.RequestLog{Model: "a", CreatedAt: base})

	snapshot := broker.Snapshot()
	if len(snapshot) != 2 {
		t.Fatalf("snapshot holds %d calls, want 2", len(snapshot))
	}
	if snapshot[0].Key != "first" || snapshot[1].Key != "second" {
		t.Fatalf("snapshot order is %q then %q, want oldest first",
			snapshot[0].Key, snapshot[1].Key)
	}
	if snapshot[0].State != StateLive {
		t.Fatalf("snapshot state is %v, want live", snapshot[0].State)
	}
}

// The relay keeps writing to its own entry for the rest of the request, so the
// broker has to hold a copy or the snapshot would report the call's later life.
func TestAnnounceCopiesTheEntry(t *testing.T) {
	broker := New()
	entry := &model.RequestLog{Model: "gpt-5"}

	broker.Announce("k", entry)
	entry.Model = "rewritten-after-announce"

	if got := broker.Snapshot()[0].Entry.Model; got != "gpt-5" {
		t.Fatalf("snapshot followed the caller's later write: %q", got)
	}
}

// Announce is also the update path: a retry moves the call to another channel,
// and the console's row has to name the upstream now being waited on.
func TestAnnounceUpsertsOnTheKey(t *testing.T) {
	broker := New()
	broker.Announce("k", &model.RequestLog{ChannelID: 1})
	broker.Announce("k", &model.RequestLog{ChannelID: 2})

	snapshot := broker.Snapshot()
	if len(snapshot) != 1 {
		t.Fatalf("re-announcing added a call: %d live", len(snapshot))
	}
	if snapshot[0].Entry.ChannelID != 2 {
		t.Fatalf("snapshot kept channel %d, want the re-announced 2",
			snapshot[0].Entry.ChannelID)
	}
}

// A settled row retires the placeholder it replaces; anything else would leave
// every finished call in the live set forever.
func TestPublishRetiresTheLiveEntry(t *testing.T) {
	broker := New()
	broker.Announce("k", &model.RequestLog{})
	broker.Publish("k", &model.RequestLog{ID: 9})

	if got := broker.LiveCount(); got != 0 {
		t.Fatalf("%d calls still live after the row settled", got)
	}
}

// The relay defers this so no exit path can leave a row running forever —
// including the one that writes no log at all, when the caller hangs up during
// a retry backoff.
func TestForgetDropsWithoutAnnouncing(t *testing.T) {
	broker := New()
	broker.Announce("k", &model.RequestLog{})

	sub, _ := broker.Subscribe()
	defer sub.Close()
	broker.Forget("k")

	if got := broker.LiveCount(); got != 0 {
		t.Fatalf("%d calls still live after Forget", got)
	}
	select {
	case event := <-sub.Events:
		t.Fatalf("Forget announced %+v", event)
	default:
	}
}

// The relay publishes from its settlement path, so a console that stopped
// reading must never block it. Losing events is the correct trade.
func TestPublishNeverBlocksOnASlowConsumer(t *testing.T) {
	broker := New()
	sub, _ := broker.Subscribe()
	defer sub.Close()

	total := subscriberBuffer + 50
	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < total; i++ {
			broker.Publish("", &model.RequestLog{ID: int64(i)})
		}
	}()

	select {
	case <-done:
	case <-timeoutAfterSeconds(5):
		t.Fatal("Publish blocked on a consumer that never read")
	}

	if got := sub.Dropped(); got != int64(total-subscriberBuffer) {
		t.Fatalf("dropped %d, want %d", got, total-subscriberBuffer)
	}
}

func TestSubscriberLimit(t *testing.T) {
	broker := New()
	subs := make([]*Subscription, 0, maxSubscribers)
	for i := 0; i < maxSubscribers; i++ {
		sub, ok := broker.Subscribe()
		if !ok {
			t.Fatalf("refused subscriber %d, below the cap", i)
		}
		subs = append(subs, sub)
	}
	if _, ok := broker.Subscribe(); ok {
		t.Fatal("accepted a subscriber beyond the cap")
	}

	// Closing one frees a slot.
	subs[0].Close()
	if _, ok := broker.Subscribe(); !ok {
		t.Fatal("a closed subscription did not free its slot")
	}
	for _, sub := range subs[1:] {
		sub.Close()
	}
}

func TestCloseIsIdempotentAndConcurrencySafe(t *testing.T) {
	broker := New()
	sub, _ := broker.Subscribe()

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sub.Close() // Must not panic on a double close of the channel.
		}()
	}
	wg.Wait()

	if _, open := <-sub.Events; open {
		t.Fatal("the event channel should be closed and drained")
	}
	if broker.Subscribers() != 0 {
		t.Fatalf("subscriber still registered: %d", broker.Subscribers())
	}

	// Publishing with no subscribers must be harmless.
	broker.Publish("", &model.RequestLog{ID: 1})
}

func TestPublishIgnoresNil(t *testing.T) {
	broker := New()
	sub, _ := broker.Subscribe()
	defer sub.Close()

	broker.Publish("", nil)
	broker.Announce("k", nil)
	broker.Announce("", &model.RequestLog{ID: 1})
	select {
	case event := <-sub.Events:
		t.Fatalf("nil was forwarded as %+v", event)
	default:
	}
	if got := broker.LiveCount(); got != 0 {
		t.Fatalf("%d calls recorded from nil announcements", got)
	}
}
