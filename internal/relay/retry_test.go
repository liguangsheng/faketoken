package relay

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// A channel's own retries are only worth spending on failures the same upstream
// could answer differently. A 4xx the request itself caused would come back
// verbatim, so those move on to another channel instead.
func TestRetryableOnSameChannel(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   bool
	}{
		{"transport error", 0, true},
		{"rate limited", http.StatusTooManyRequests, true},
		{"upstream 500", http.StatusInternalServerError, true},
		{"upstream 502", http.StatusBadGateway, true},
		{"bad request", http.StatusBadRequest, false},
		{"unauthorized", http.StatusUnauthorized, false},
		{"not found", http.StatusNotFound, false},
	}
	for _, tc := range cases {
		if got := retryableOnSameChannel(attemptOutcome{status: tc.status}); got != tc.want {
			t.Errorf("%s: retryableOnSameChannel(%d) = %v, want %v", tc.name, tc.status, got, tc.want)
		}
	}
}

// The ceiling is what stops a generous per-channel backoff from stalling a
// request: the wait honours ceiling, not base × attempt.
func TestPauseBeforeRetryHonoursCeiling(t *testing.T) {
	start := time.Now()
	if !pauseBeforeRetry(context.Background(), 10, time.Hour, 20*time.Millisecond) {
		t.Fatal("pauseBeforeRetry reported a live context as cancelled")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("waited %s, want the 20ms ceiling", elapsed)
	}
}

func TestPauseBeforeRetryWithoutBaseOrContext(t *testing.T) {
	if !pauseBeforeRetry(context.Background(), 3, 0, maxRetryPause) {
		t.Fatal("a zero base should return at once, not fail")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if pauseBeforeRetry(ctx, 1, time.Hour, time.Hour) {
		t.Fatal("a caller that hung up must stop the retry loop")
	}
}
