package relay

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/model"
)

// DefaultCaptureLimit is how much of a request or response is kept for the
// full-log view. Models now take million-token contexts, which run to several
// megabytes of JSON, so an exchange has to be captured at that scale to be
// worth reading back.
const DefaultCaptureLimit = 4 << 20

// captureLimit reads the operator-configured cap. It is consulted on every
// relayed request, so it lives in memory rather than in the options table.
func (rl *Relay) captureLimit() int {
	if limit := int(rl.capture.Load()); limit > 0 {
		return limit
	}
	return DefaultCaptureLimit
}

// SetCaptureLimit updates the cap without a restart.
func (rl *Relay) SetCaptureLimit(bytes int) {
	if bytes > 0 {
		rl.capture.Store(int64(bytes))
	}
}

// DefaultRetryBudget is the fallback max retry count when no stored option
// exists. Matches the environment default for MAX_RETRIES.
const DefaultRetryBudget = 3

// DefaultRetryBackoff is the fallback inter-retry base delay when no stored
// option exists. Matches the environment default for RETRY_BACKOFF.
const DefaultRetryBackoff = 200 * time.Millisecond

// retryBudgetValue reads the operator-configured cap on how many channels one
// request may visit before it gives up. A channel's own retry_count is spent on
// top of it. Consulted per request, so it lives in memory rather than in the
// options table.
func (rl *Relay) retryBudgetValue() int {
	if n := int(rl.retryBudget.Load()); n > 0 {
		return n
	}
	return DefaultRetryBudget
}

// retryBackoffValue reads the operator-configured inter-retry base delay. It
// spaces the move to another channel; a channel that sets retry_backoff_ms
// spaces its own retries with that instead.
func (rl *Relay) retryBackoffValue() time.Duration {
	if d := time.Duration(rl.retryBackoff.Load()); d > 0 {
		return d
	}
	return DefaultRetryBackoff
}

// SetRetryConfig updates the retry attempt cap and the inter-retry backoff
// base without a restart. The cap counts channels, not attempts: it bounds how
// many upstreams one request may visit, each of which may be tried several
// times under its own retry_count.
func (rl *Relay) SetRetryConfig(maxRetries int, backoff time.Duration) {
	if maxRetries < 1 {
		maxRetries = 1
	}
	rl.retryBudget.Store(int64(maxRetries))
	if backoff > 0 {
		rl.retryBackoff.Store(int64(backoff))
	}
}

// capturedRequest is what the log will be built from, with the expensive part
// left undone.
//
// Sanitising a body means parsing it, walking it and re-encoding it — around
// 25ms per megabyte, and coding agents replay whole transcripts, so a typical
// request here is over a megabyte. Doing that before the upstream is even
// contacted would put that time in front of every answer, purely to prepare a
// diagnostic. So the raw bytes are held and converted later, on the goroutine
// that writes the log after the client has been served.
type capturedRequest struct {
	headers     map[string][]string
	body        []byte
	contentType string
	// liveKey ties the in-flight announcements of this call to the row that
	// ends it, so a console can replace the placeholder it drew instead of
	// appending a second row for the same request. Empty for a call that was
	// answered before it ever reached an upstream: nothing was announced, so
	// there is nothing to replace. It rides here because this struct is already
	// what every logging path carries from the request to the row it writes.
	liveKey string
	// Filled in once an upstream has answered; sanitising a response happens
	// after the client already has the bytes, so it is not on the critical
	// path in the same way.
	responseHeaders   map[string][]string
	responseBody      string
	responseTruncated bool
}

// captureRequest records the cheap half now. Headers are a handful of short
// strings, so folding them costs nothing worth deferring.
func captureRequest(r *http.Request, body []byte) *capturedRequest {
	return &capturedRequest{
		headers:     sanitizeHeaders(r.Header),
		body:        body,
		contentType: r.Header.Get("Content-Type"),
	}
}

// detail does the deferred work and produces the row to store.
func (c *capturedRequest) detail(limit int) *model.RequestLogDetail {
	requestBody, truncated := sanitizeBody(c.contentType, c.body, false, limit)
	return &model.RequestLogDetail{
		RequestHeaders:    c.headers,
		RequestBody:       requestBody,
		RequestTruncated:  truncated,
		ResponseHeaders:   c.responseHeaders,
		ResponseBody:      c.responseBody,
		ResponseTruncated: c.responseTruncated,
	}
}

// sanitizeHeaders copies headers with credentials removed. Sorted so a stored
// record reads the same way twice, and bounded so a pathological client cannot
// turn one request into an unbounded row.
func sanitizeHeaders(headers http.Header) map[string][]string {
	out := make(map[string][]string, len(headers))
	keys := make([]string, 0, len(headers))
	for key := range headers {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for index, key := range keys {
		if index >= 100 {
			out["X-Log-Truncated"] = []string{"additional headers omitted"}
			break
		}
		canonical := http.CanonicalHeaderKey(key)
		if sensitiveHeader(canonical) {
			out[canonical] = []string{"[REDACTED]"}
			continue
		}
		values := headers.Values(key)
		clean := make([]string, 0, len(values))
		for _, value := range values {
			if len(value) > 2048 {
				value = value[:2048] + "...[TRUNCATED]"
			}
			clean = append(clean, strings.ToValidUTF8(value, "?"))
		}
		out[canonical] = clean
	}
	return out
}

func sensitiveHeader(name string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(name, "-", ""))
	switch normalized {
	case "authorization", "proxyauthorization", "cookie", "setcookie", "xapikey",
		"xgoogapikey", "apikey", "xauthtoken", "xaccesstoken":
		return true
	}
	return strings.Contains(normalized, "secret")
}

// sanitizeBody renders a body for storage: truncated to the limit, redacted,
// and reduced to a note when it is binary or too large to be useful.
func sanitizeBody(contentType string, body []byte, alreadyTruncated bool, limit int) (string, bool) {
	if len(body) == 0 {
		return "", alreadyTruncated
	}
	if limit <= 0 {
		limit = DefaultCaptureLimit
	}
	originalSize := len(body)
	truncated := alreadyTruncated || originalSize > limit
	if originalSize > limit {
		body = body[:limit]
	}

	mediaType, _, _ := mime.ParseMediaType(contentType)
	mediaType = strings.ToLower(mediaType)
	isJSON := strings.Contains(mediaType, "json") || (!truncated && json.Valid(body))
	if isJSON {
		if truncated || !json.Valid(body) {
			return fmt.Sprintf("[JSON body omitted: exceeds %d bytes]", limit), true
		}
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		var payload any
		if err := dec.Decode(&payload); err == nil {
			redactJSON(payload)
			if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
				return capDetailString(string(encoded), truncated, limit)
			}
		}
	}

	if strings.Contains(mediaType, "event-stream") {
		return capDetailString(sanitizeEventStream(body, truncated), truncated, limit)
	}
	if !isTextMediaType(mediaType) {
		return fmt.Sprintf("[binary body omitted: %d bytes, content-type %s]", originalSize, mediaType), truncated
	}
	return capDetailString(strings.ToValidUTF8(string(body), "?"), truncated, limit)
}

// capDetailString bounds the rendered form. Re-indenting JSON can push a body
// past the limit that was applied to the raw bytes, so the result is measured
// again rather than assumed to still fit.
func capDetailString(value string, truncated bool, limit int) (string, bool) {
	if limit <= 0 || len(value) <= limit {
		return value, truncated
	}
	// Cut on the byte limit, then drop whatever partial rune the cut left
	// behind so the stored text stays valid UTF-8.
	return strings.ToValidUTF8(value[:limit], "") + "...[TRUNCATED]", true
}

// sanitizeEventStream redacts each SSE data frame in place, leaving the frame
// structure intact so the stream still reads as a stream.
func sanitizeEventStream(body []byte, truncated bool) string {
	lines := strings.Split(strings.ToValidUTF8(string(body), "?"), "\n")
	if truncated && len(lines) > 0 {
		// The final line was cut mid-frame; keeping it would store a fragment
		// that cannot be parsed.
		lines = lines[:len(lines)-1]
	}
	for index, line := range lines {
		prefix, payload, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(prefix) != "data" {
			continue
		}
		raw := strings.TrimSpace(payload)
		if raw == "" || raw == "[DONE]" || !json.Valid([]byte(raw)) {
			continue
		}
		var value any
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.UseNumber()
		if dec.Decode(&value) == nil {
			redactJSON(value)
			if encoded, err := json.Marshal(value); err == nil {
				lines[index] = "data: " + string(encoded)
			}
		}
	}
	return strings.Join(lines, "\n")
}

// isTextMediaType reports whether a body is worth storing as text. Anything
// else is recorded as a note: bytes of an image or an archive are unreadable
// in a log and would only take up room.
func isTextMediaType(mediaType string) bool {
	// An absent Content-Type is treated as text; the alternative is discarding
	// bodies that are perfectly readable.
	if mediaType == "" || strings.HasPrefix(mediaType, "text/") {
		return true
	}
	switch mediaType {
	case "application/json", "application/xml", "application/javascript",
		"application/x-ndjson", "application/x-www-form-urlencoded":
		return true
	}
	return strings.Contains(mediaType, "json") ||
		strings.Contains(mediaType, "xml") ||
		strings.Contains(mediaType, "text")
}

// redactJSON walks a decoded body and replaces the value of any key that names
// a credential.
func redactJSON(value any) {
	switch item := value.(type) {
	case map[string]any:
		for key, child := range item {
			if sensitiveJSONKey(key) {
				item[key] = "[REDACTED]"
				continue
			}
			redactJSON(child)
		}
	case []any:
		for _, child := range item {
			redactJSON(child)
		}
	}
}

func sensitiveJSONKey(key string) bool {
	normalized := strings.ToLower(strings.NewReplacer("_", "", "-", "", ".", "").Replace(key))
	switch normalized {
	case "authorization", "proxyauthorization", "apikey", "xapikey", "xgoogapikey",
		"password", "passwd", "secret", "clientsecret", "accesstoken", "refreshtoken",
		"idtoken", "bearertoken", "token":
		return true
	}
	return strings.HasSuffix(normalized, "secret")
}
