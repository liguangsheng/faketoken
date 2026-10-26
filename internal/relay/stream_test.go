package relay

import (
	"context"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/faketoken/faketoken/internal/redact"
)

// The exact shape that started this: a 200 text/event-stream, a few pings, then
// an error event. The status line says the call worked, the body says it did not.
func TestUsageSnifferReportsAnthropicStreamError(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: {\"type\":\"ping\"}\n\n" +
		"data: {\"type\":\"ping\"}\n\n" +
		"data: {\"error\":{\"message\":\"Concurrency limit exceeded for account, please retry later\"," +
		"\"type\":\"rate_limit_error\"},\"type\":\"error\"}\n\n"))

	failure, failed := sniff.StreamError()
	if !failed {
		t.Fatal("the error event in the stream went unnoticed")
	}
	if failure.Type != "rate_limit_error" ||
		!strings.Contains(failure.Message, "Concurrency limit exceeded") {
		t.Fatalf("got %+v, want the upstream rate-limit error", failure)
	}
	if msg := streamFailureMessage(failure); !strings.Contains(msg, "rate_limit_error") ||
		!strings.Contains(msg, "Concurrency limit exceeded") {
		t.Fatalf("log message lost the upstream detail: %s", msg)
	}
}

// A stream that carried content before failing still has to be flagged: the
// caller got a partial answer, and the channel still refused to finish it.
func TestUsageSnifferReportsStreamErrorAfterContent(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte(
		"data: {\"choices\":[{\"delta\":{\"content\":\"he\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2}}\n\n" +
			"data: {\"error\":{\"message\":\"upstream closed\",\"type\":\"server_error\"}}\n\n"))

	if _, failed := sniff.StreamError(); !failed {
		t.Fatal("a failure after content went unnoticed")
	}
	// Usage accounting is unaffected: those tokens were really spent.
	usage, ok := sniff.Usage()
	if !ok || usage.PromptTokens != 10 || usage.CompletionTokens != 2 {
		t.Fatalf("usage = %+v, %v; want the partial usage preserved", usage, ok)
	}
}

// An error split across two writes is the normal case on the wire: the sniffer
// sees whatever the transport hands it, not whole events.
func TestUsageSnifferReassemblesStreamErrorAcrossWrites(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: {\"error\":{\"mess"))
	if _, failed := sniff.StreamError(); failed {
		t.Fatal("half an event was already scored as a failure")
	}
	_, _ = sniff.Write([]byte("age\":\"overloaded\",\"type\":\"overloaded_error\"}}\n\n"))

	failure, failed := sniff.StreamError()
	if !failed || failure.Message != "overloaded" {
		t.Fatalf("got %+v, %v; want the reassembled error", failure, failed)
	}
}

// Some upstreams put the failure only in the event name and send an unlabelled
// payload, which is invisible to a detector that reads the data line alone.
func TestUsageSnifferReadsErrorEventName(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("event: error\ndata: {\"message\":\"account suspended\"}\n\n"))

	failure, failed := sniff.StreamError()
	if !failed {
		t.Fatal("an event: error line went unnoticed")
	}
	if failure.Message != "account suspended" {
		t.Fatalf("Message = %q, want the upstream text", failure.Message)
	}
}

// An event name only applies until the blank line that closes its event.
// Leaking it would mark every later chunk as a failure.
func TestUsageSnifferForgetsEventNameAfterTheEvent(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\"}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))

	if failure, failed := sniff.StreamError(); failed {
		t.Fatalf("a healthy stream was flagged as %+v", failure)
	}
}

// A completed stream must stay clean, or every request would be logged as a
// failure and every channel benched.
func TestUsageSnifferAcceptsHealthyStream(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte(
		"event: content_block_delta\n" +
			"data: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"the error was mine\"}}\n\n" +
			"data: {\"choices\":[{\"delta\":{}}],\"error\":null}\n\n" +
			"data: [DONE]\n\n"))

	if failure, failed := sniff.StreamError(); failed {
		t.Fatalf("a healthy stream was flagged as %+v", failure)
	}
}

// The same failure arrives without SSE framing when a client asks for a
// non-streamed reply, and it is just as invisible behind a 200.
func TestUsageSnifferReportsNonStreamErrorBody(t *testing.T) {
	sniff := newUsageSniffer("application/json", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte(`{"error":{"code":429,"message":"Resource has been exhausted"}}`))

	failure, failed := sniff.StreamError()
	if !failed || failure.Status != 429 {
		t.Fatalf("got %+v, %v; want the 429 hidden in the body", failure, failed)
	}
	if msg := streamFailureMessage(failure); !strings.Contains(msg, "HTTP 429") {
		t.Fatalf("log message dropped the upstream status: %s", msg)
	}
}

func TestUsageSnifferAcceptsHealthyNonStreamBody(t *testing.T) {
	sniff := newUsageSniffer("application/json", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte(`{"choices":[{"message":{"content":"hello"}}],` +
		`"usage":{"prompt_tokens":1,"completion_tokens":1}}`))

	if failure, failed := sniff.StreamError(); failed {
		t.Fatalf("a healthy body was flagged as %+v", failure)
	}
}

// A body that never says [DONE] is not finished: the relay still owes the caller
// the rest of the stream, however long the upstream sits on it.
func TestUsageSnifferDoesNotTerminateEarly(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))

	if sniff.Terminated() {
		t.Fatal("a stream with content but no terminator was called complete")
	}
}

// [DONE] is the marker the caller stops reading on, so it is what ends the call
// even when the upstream keeps the connection open afterwards.
func TestUsageSnifferSeesTerminatorSplitAcrossWrites(t *testing.T) {
	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte("data: [DO"))
	_, _ = sniff.Write([]byte("NE]\n\n"))

	if !sniff.Terminated() {
		t.Fatal("the terminator split across two writes went unnoticed")
	}
	// Usage accounting still works off the same events: nothing is skipped.
	_, _ = sniff.Write([]byte("data: {\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":3}}\n\n"))
	usage, ok := sniff.Usage()
	if !ok || usage.PromptTokens != 7 || usage.CompletionTokens != 3 {
		t.Fatalf("usage = %+v, %v; want the usage that followed the terminator", usage, ok)
	}
}

// A non-streamed body has no terminator, so nothing there may end early.
func TestUsageSnifferNeverTerminatesWithoutSSE(t *testing.T) {
	sniff := newUsageSniffer("application/json", redact.DefaultCaptureLimit)
	_, _ = sniff.Write([]byte(`{"choices":[{"message":{"content":"data: [DONE]"}}]}`))

	if sniff.Terminated() {
		t.Fatal("a body that merely contains the marker was called terminated")
	}
}

// stubBody hands out the bytes it holds and then blocks, which is an upstream
// that answered in full and kept the connection open: nothing is coming, but no
// EOF either.
type stubBody struct {
	data  []byte
	pos   int
	block chan struct{}
	ctx   context.Context
	once  sync.Once
}

func newStubBody(ctx context.Context, data string) *stubBody {
	return &stubBody{data: []byte(data), block: make(chan struct{}), ctx: ctx}
}

func (b *stubBody) Read(p []byte) (int, error) {
	if b.pos < len(b.data) {
		n := copy(p, b.data[b.pos:])
		b.pos += n
		return n, nil
	}
	select {
	case <-b.ctx.Done():
		// What an http.Client hands back once the relay cancels the request:
		// the read ends in the context error, not in io.EOF.
		return 0, b.ctx.Err()
	case <-b.block:
		return 0, io.EOF
	}
}

// release lets the blocked reader finish, so the goroutine parked in Read does
// not outlive the test.
func (b *stubBody) release() { b.once.Do(func() { close(b.block) }) }

// The caller that prompted all of this: the client received the whole answer,
// including [DONE], and hung up. The relay must have logged a clean call, not
// waited for an upstream FIN that decided to take its time.
func TestPumpEndsOnTheStreamTerminatorWithoutACancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := newStubBody(ctx, `data: {"choices":[{"delta":{"content":"hi"}}]}`+"\n\n"+
		"data: [DONE]\n\n")
	defer body.release()

	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	rec := httptest.NewRecorder()

	var cancelled atomic.Bool
	// pump only ever sees this wrapper: it must not need a cancel to end a
	// call the upstream already finished.
	notifyCancel := func() {
		cancelled.Store(true)
	}

	type result struct {
		written int64
		ttfb    time.Duration
		err     error
	}
	done := make(chan result, 1)
	go func() {
		written, ttfb, err := pump(rec, body, sniff, true, time.Hour, notifyCancel, nil)
		done <- result{written, ttfb, err}
	}()

	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("pump ended with %v, want the completed stream to end cleanly", got.err)
		}
		if got.written == 0 {
			t.Fatal("nothing was relayed")
		}
		if got.ttfb == 0 {
			t.Fatal("time to first byte was not measured")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("pump is still waiting for an upstream that already said [DONE]")
	}

	if !strings.Contains(rec.Body.String(), "[DONE]") {
		t.Fatalf("terminator was not relayed: %q", rec.Body.String())
	}
	if cancelled.Load() {
		t.Fatal("the call needed a cancelled context to finish")
	}
}

// The counter-case: content is still owed, so a stalled stream has to be cut
// off by the idle timeout rather than by the terminator this test never sends.
func TestPumpStillIdleTimesOutAStreamThatNeverEnds(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	body := newStubBody(ctx, `data: {"choices":[{"delta":{"content":"hi"}}]}`+"\n\n")
	defer body.release()

	sniff := newUsageSniffer("text/event-stream", redact.DefaultCaptureLimit)
	rec := httptest.NewRecorder()

	done := make(chan error, 1)
	go func() {
		_, _, err := pump(rec, body, sniff, true, 50*time.Millisecond, cancel, nil)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a stream that only ever stalls must not be reported as complete")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the idle timeout never fired")
	}
	if ctx.Err() == nil {
		t.Fatal("the idle timeout has to cancel the upstream request")
	}
}

// A long stream stays within the bound, and a stall keeps its edges at any
// resolution: the sample before it and the one after are both still there.
func TestTimelineThinsButKeepsStalls(t *testing.T) {
	start := time.Unix(0, 0)
	tl := newTimeline(start)
	at := func(ms int) time.Time { return start.Add(time.Duration(ms) * time.Millisecond) }

	bytes := int64(0)
	for ms := 0; ms < 600_000; ms += 7 { // ten minutes, a chunk every 7ms
		if ms > 300_000 && ms < 330_000 {
			continue // a 30-second stall half way through
		}
		bytes += 100
		tl.add(at(ms), bytes)
	}

	s := tl.pairs()
	if len(s) > 2*timelinePairs {
		t.Fatalf("%d pairs, want at most %d", len(s)/2, timelinePairs)
	}
	if s[len(s)-1] != int32(bytes) {
		t.Fatalf("last sample has %d bytes, want %d", s[len(s)-1], bytes)
	}
	stalled := false
	for i := 2; i < len(s); i += 2 {
		if s[i-2] <= 300_000 && s[i] >= 330_000 && s[i]-s[i-2] < 31_000 {
			stalled = true
		}
	}
	if !stalled {
		t.Fatal("the 30-second stall did not survive thinning")
	}
}
