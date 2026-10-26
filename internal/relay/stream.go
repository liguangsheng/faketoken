package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
	"github.com/faketoken/faketoken/internal/redact"
)

// maxSniffBytes caps how much of a non-streamed body is buffered purely for
// token accounting. Beyond this the request is still relayed byte-for-byte,
// only the usage numbers are given up.
const maxSniffBytes = 8 << 20

// usageSniffer observes the bytes flowing to the client and extracts token
// usage without altering or delaying the stream.
type usageSniffer struct {
	// captureMax bounds the bytes kept for the session log, independently of
	// the larger buffer used for token accounting.
	captureMax int
	sse        bool
	acc        provider.UsageAccumulator
	failure    provider.StreamErrorAccumulator
	buf        bytes.Buffer
	over       bool
	inSSE      bytes.Buffer // partial SSE line carried across chunk boundaries
	// event is the name of the SSE event the next data line belongs to. An
	// upstream that labels the event `error` but sends an unlabelled payload is
	// only recognisable by carrying the name across the two lines.
	event string
	// terminated records the end-of-stream marker. Once it has been seen the
	// response is complete, whatever the upstream does with the connection next.
	terminated  bool
	capture     bytes.Buffer
	captureOver bool
	// content records that an event carrying part of the answer went by, so
	// a stream that breaks afterwards is known to have delivered something.
	content bool
}

func newUsageSniffer(contentType string, captureMax int) *usageSniffer {
	if captureMax <= 0 {
		captureMax = redact.DefaultCaptureLimit
	}
	return &usageSniffer{
		captureMax: captureMax,
		sse:        strings.Contains(strings.ToLower(contentType), "event-stream"),
	}
}

func (s *usageSniffer) Write(p []byte) (int, error) {
	if remaining := s.captureMax - s.capture.Len(); remaining > 0 {
		keep := min(remaining, len(p))
		s.capture.Write(p[:keep])
		if keep < len(p) {
			s.captureOver = true
		}
	} else if len(p) > 0 {
		s.captureOver = true
	}
	if s.over {
		return len(p), nil
	}
	if s.sse {
		s.feedSSE(p)
		return len(p), nil
	}
	if s.buf.Len()+len(p) > maxSniffBytes {
		s.over = true
		s.buf.Reset()
		return len(p), nil
	}
	s.buf.Write(p)
	return len(p), nil
}

func (s *usageSniffer) Capture() ([]byte, bool) {
	return s.capture.Bytes(), s.captureOver
}

func (s *usageSniffer) feedSSE(p []byte) {
	s.inSSE.Write(p)
	for {
		data := s.inSSE.Bytes()
		idx := bytes.IndexByte(data, '\n')
		if idx < 0 {
			// Guard against a pathological upstream that never emits newlines.
			if s.inSSE.Len() > 1<<20 {
				s.inSSE.Reset()
			}
			return
		}
		line := bytes.TrimRight(data[:idx], "\r")
		s.inSSE.Next(idx + 1)

		if name, ok := bytes.CutPrefix(line, []byte("event:")); ok {
			s.event = string(bytes.TrimSpace(name))
			continue
		}
		payload, ok := bytes.CutPrefix(line, []byte("data:"))
		if !ok {
			// A blank line closes the event, so the name must not leak into
			// whatever event comes next.
			if len(line) == 0 {
				s.event = ""
			}
			continue
		}
		payload = bytes.TrimSpace(payload)
		if len(payload) == 0 {
			continue
		}
		if bytes.Equal(payload, []byte("[DONE]")) {
			s.terminated = true
			continue
		}
		if !s.content {
			s.content = provider.ContentEvent(s.event, payload)
		}
		s.acc.Feed(payload)
		if !s.failure.Feed(payload) && isErrorEventName(s.event) {
			// The payload did not identify itself, but the event line did.
			s.failure.Feed(errorEventPayload(s.event, payload))
		}
	}
}

// isErrorEventName reports SSE event names that declare a failure. Covers
// Anthropic's bare `error` and the dotted names the Responses API uses
// (`response.failed`, `response.incomplete`, `error.*`).
func isErrorEventName(name string) bool {
	name = strings.ToLower(strings.TrimSpace(name))
	switch name {
	case "":
		return false
	case "error", "response.failed", "response.incomplete":
		return true
	}
	return strings.HasSuffix(name, ".error") || strings.HasSuffix(name, "_error")
}

// errorEventPayload rewrites an unlabelled payload as the error the event line
// says it is, so the shared detector can read it. The upstream's own text is
// preserved when it sent any.
func errorEventPayload(event string, payload []byte) []byte {
	var named struct {
		Message string `json:"message"`
		Detail  string `json:"detail"`
	}
	message := ""
	if json.Unmarshal(payload, &named) == nil {
		message = strings.TrimSpace(named.Message)
		if message == "" {
			message = strings.TrimSpace(named.Detail)
		}
	}
	if message == "" {
		message = "upstream sent an SSE " + event + " event"
	}
	wrapped, err := json.Marshal(map[string]any{
		"error": map[string]any{"message": message, "type": event},
	})
	if err != nil {
		return payload
	}
	return wrapped
}

func (s *usageSniffer) Usage() (model.Usage, bool) {
	if !s.sse && s.buf.Len() > 0 {
		s.acc.Feed(s.buf.Bytes())
	}
	return s.acc.Result()
}

// StreamError reports a failure the upstream delivered inside the body: an SSE
// error event, or a JSON error object in a body that came with a 2xx status.
func (s *usageSniffer) StreamError() (provider.StreamError, bool) {
	if !s.sse && s.buf.Len() > 0 {
		s.failure.Feed(s.buf.Bytes())
	}
	return s.failure.Result()
}

// Body returns the buffered non-streamed body, used to surface upstream error
// details in the request log.
func (s *usageSniffer) Body() []byte {
	if s.sse || s.over {
		return nil
	}
	return s.buf.Bytes()
}

// Terminated reports whether the stream already carried its end-of-stream
// marker. An upstream that keeps the connection open after it — the common case
// for anything behind a shared gateway — never sends the EOF a relay would
// otherwise wait for, and the caller has stopped reading anyway.
func (s *usageSniffer) Terminated() bool { return s.terminated }

// Delivered reports whether the answer itself began to reach the caller. A
// body that is not a stream counts once any of it was written: the upstream
// produced it whole before sending the first byte.
func (s *usageSniffer) Delivered(written int64) bool {
	if s.sse {
		return s.content
	}
	return written > 0
}

// errCallerGone marks a write to the caller that failed: the caller left, which
// is not the upstream's doing however the stream ended.
var errCallerGone = errors.New("caller went away")

// errStreamIdle is the cause the idle watchdog cancels with, so a stalled
// upstream is not mistaken for a caller that hung up: both end the read alike.
var errStreamIdle = errors.New("upstream went quiet")

// pump relays the upstream body to the client, flushing every chunk so that
// SSE and other incremental formats reach the caller without added latency.
// It reports time-to-first-byte and enforces an idle timeout by cancelling the
// upstream request context when a stream stalls.
func pump(w http.ResponseWriter, body io.Reader, sniff *usageSniffer, flush bool,
	idle time.Duration, cancel context.CancelFunc) (written int64, ttfb time.Duration, err error) {

	rc := http.NewResponseController(w)
	start := time.Now()

	var lastActivity atomic.Int64
	lastActivity.Store(start.UnixNano())
	done := make(chan struct{})
	defer close(done)

	if idle > 0 {
		go func() {
			ticker := time.NewTicker(idle / 2)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case now := <-ticker.C:
					if now.UnixNano()-lastActivity.Load() > int64(idle) {
						cancel()
						return
					}
				}
			}
		}()
	}

	buf := make([]byte, 32*1024)
	first := true
	for {
		n, readErr := body.Read(buf)
		if n > 0 {
			if first {
				ttfb = time.Since(start)
				first = false
			}
			lastActivity.Store(time.Now().UnixNano())

			chunk := buf[:n]
			_, _ = sniff.Write(chunk)
			if _, writeErr := w.Write(chunk); writeErr != nil {
				return written, ttfb, fmt.Errorf("%w: %w", errCallerGone, writeErr)
			}
			written += int64(n)
			if flush {
				// A failed Flush only means the writer does not support it.
				_ = rc.Flush()
			}
			if sniff.Terminated() {
				// [DONE] is the end of the response, so the upstream's FIN says
				// nothing the caller still needs: a client stops reading at the
				// marker and drops the connection within milliseconds, and an
				// upstream behind a shared gateway often holds that connection
				// open. Waiting for the winner of that race is how a finished
				// call ends up logged as "stream interrupted: context canceled".
				return written, ttfb, nil
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				return written, ttfb, nil
			}
			return written, ttfb, readErr
		}
	}
}
