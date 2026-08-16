package relay

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
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
	captureMax  int
	sse         bool
	acc         provider.UsageAccumulator
	buf         bytes.Buffer
	over        bool
	inSSE       bytes.Buffer // partial SSE line carried across chunk boundaries
	capture     bytes.Buffer
	captureOver bool
}

func newUsageSniffer(contentType string, captureMax int) *usageSniffer {
	if captureMax <= 0 {
		captureMax = DefaultCaptureLimit
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

		payload, ok := bytes.CutPrefix(line, []byte("data:"))
		if !ok {
			continue
		}
		payload = bytes.TrimSpace(payload)
		if len(payload) == 0 || bytes.Equal(payload, []byte("[DONE]")) {
			continue
		}
		s.acc.Feed(payload)
	}
}

func (s *usageSniffer) Usage() (model.Usage, bool) {
	if !s.sse && s.buf.Len() > 0 {
		s.acc.Feed(s.buf.Bytes())
	}
	return s.acc.Result()
}

// Body returns the buffered non-streamed body, used to surface upstream error
// details in the request log.
func (s *usageSniffer) Body() []byte {
	if s.sse || s.over {
		return nil
	}
	return s.buf.Bytes()
}

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
				return written, ttfb, writeErr
			}
			written += int64(n)
			if flush {
				// A failed Flush only means the writer does not support it.
				_ = rc.Flush()
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
