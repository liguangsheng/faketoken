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

	broker.Publish(&model.RequestLog{ID: 7})

	for name, sub := range map[string]*Subscription{"first": first, "second": second} {
		select {
		case entry := <-sub.Events:
			if entry.ID != 7 {
				t.Fatalf("%s received id %d", name, entry.ID)
			}
		default:
			t.Fatalf("%s received nothing", name)
		}
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
			broker.Publish(&model.RequestLog{ID: int64(i)})
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
	broker.Publish(&model.RequestLog{ID: 1})
}

func TestPublishIgnoresNil(t *testing.T) {
	broker := New()
	sub, _ := broker.Subscribe()
	defer sub.Close()

	broker.Publish(nil)
	select {
	case entry := <-sub.Events:
		t.Fatalf("nil was forwarded as %+v", entry)
	default:
	}
}
