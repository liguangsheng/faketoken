package relay

import (
	"strings"
	"testing"

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
