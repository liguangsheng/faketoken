package relay

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

// conversationBody builds a request the size a coding agent actually sends:
// the whole transcript is replayed on every turn, so these run to megabytes.
func conversationBody(turns int) []byte {
	messages := make([]map[string]any, 0, turns)
	for i := range turns {
		messages = append(messages, map[string]any{
			"role":    "user",
			"content": fmt.Sprintf("turn %d: %s", i, strings.Repeat("some source code and prose. ", 60)),
		})
	}
	body, _ := json.Marshal(map[string]any{
		"model":      "claude-opus-5",
		"max_tokens": 4096,
		"messages":   messages,
	})
	return body
}

// sanitizeBody runs on the request and again on the response of every relayed
// call, so its cost is paid per request rather than per inspection.
func BenchmarkSanitizeBody(b *testing.B) {
	for _, turns := range []int{10, 100, 1000} {
		body := conversationBody(turns)
		b.Run(fmt.Sprintf("%dKiB", len(body)/1024), func(b *testing.B) {
			b.SetBytes(int64(len(body)))
			b.ReportAllocs()
			for b.Loop() {
				sanitizeBody("application/json", body, false, DefaultCaptureLimit)
			}
		})
	}
}

// matchBlocked folds the whole body once per request when any group is set.
func BenchmarkMatchBlocked(b *testing.B) {
	body := conversationBody(100)
	rl := &Relay{}
	rl.SetBlockPolicy([]BlockRule{{
		Name: "bench", Enabled: true, Keywords: []string{"forbidden", "another"},
	}}, DefaultBlockedStatus)

	b.SetBytes(int64(len(body)))
	b.ReportAllocs()
	for b.Loop() {
		_, _ = rl.matchBlocked(body)
	}
}
