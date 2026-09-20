package relay

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/faketoken/faketoken/internal/redact"
)

// BenchmarkCriticalPathCapture measures what a caller waits for before the
// request is forwarded: everything the relay does with the body up to the
// point an upstream is contacted.
//
// The comparison is against doing the same work eagerly, which is what used to
// happen — the numbers are the latency that was moved off the caller's path.
func BenchmarkCriticalPathCapture(b *testing.B) {
	for _, turns := range []int{10, 100, 1000} {
		body := conversationBody(turns)
		req, err := http.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(""))
		if err != nil {
			b.Fatal(err)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer sk-secret")

		size := fmt.Sprintf("%dKiB", len(body)/1024)

		b.Run("deferred/"+size, func(b *testing.B) {
			b.SetBytes(int64(len(body)))
			b.ReportAllocs()
			for b.Loop() {
				captureRequest(req, body)
			}
		})

		b.Run("eager/"+size, func(b *testing.B) {
			b.SetBytes(int64(len(body)))
			b.ReportAllocs()
			for b.Loop() {
				c := captureRequest(req, body)
				_ = c.detail(redact.DefaultCaptureLimit)
			}
		})
	}
}
