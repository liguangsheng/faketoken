package relay

import (
	"net/http"

	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/redact"
)

// CaptureLimit reads the operator-configured cap. It is consulted on every
// relayed request, so it lives in memory rather than in the options table.
// Exported so the prober can bound a stored probe the same way.
func (rl *Relay) CaptureLimit() int {
	if limit := int(rl.capture.Load()); limit > 0 {
		return limit
	}
	return redact.DefaultCaptureLimit
}

// SetCaptureLimit updates the cap without a restart.
func (rl *Relay) SetCaptureLimit(bytes int) {
	if bytes > 0 {
		rl.capture.Store(int64(bytes))
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
		headers:     redact.Headers(r.Header),
		body:        body,
		contentType: r.Header.Get("Content-Type"),
	}
}

// detail does the deferred work and produces the row to store.
func (c *capturedRequest) detail(limit int) *model.RequestLogDetail {
	requestBody, truncated := redact.Body(c.contentType, c.body, false, limit)
	responseHeaders := c.responseHeaders
	if responseHeaders == nil {
		// A call that ended before any upstream answered has no headers to
		// show. The column is NOT NULL and a nil map is encoded as NULL, which
		// would lose the whole row instead of showing an empty header list.
		responseHeaders = map[string][]string{}
	}
	return &model.RequestLogDetail{
		RequestHeaders:    c.headers,
		RequestBody:       requestBody,
		RequestTruncated:  truncated,
		ResponseHeaders:   responseHeaders,
		ResponseBody:      c.responseBody,
		ResponseTruncated: c.responseTruncated,
	}
}
