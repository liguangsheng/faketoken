package provider

import (
	"encoding/json"
	"strings"
)

// StreamError is an upstream failure that arrived inside the response body
// rather than in the status line.
//
// A gateway under pressure often answers 200 with `text/event-stream`, emits a
// few keepalive pings, then ends the stream with an error event. From the
// status code alone that request looks perfect: no error text, no channel
// failure recorded, and the breaker keeps a channel in rotation that is in
// fact refusing every call.
type StreamError struct {
	// Message is the human-readable reason, taken from whichever field the
	// dialect puts it in.
	Message string
	// Type is the upstream's own classification (`rate_limit_error`,
	// `overloaded_error`, ...), empty when it reported none.
	Type string
	// Status is the HTTP status the payload names for itself. Gemini nests a
	// real code, some gateways copy one in; 0 when nothing was stated.
	Status int
}

// rawStreamError covers the error shapes of the three dialects plus the
// wrappers used by the Responses API, so one unmarshal can score any payload.
type rawStreamError struct {
	// Present in every dialect that reports an error as an object. Anthropic
	// and OpenAI-compatible upstreams both land here; Gemini adds `code`, and
	// `status` is the textual enum some gateways send instead.
	Error *struct {
		Message string          `json:"message"`
		Type    string          `json:"type"`
		Code    json.RawMessage `json:"code"`
		Status  json.RawMessage `json:"status"`
	} `json:"error"`

	// Anthropic labels the event itself, which is what makes an error event
	// distinguishable from a content event carrying the word "error".
	Type string `json:"type"`

	// Responses API failures arrive as response.failed / response.incomplete
	// with the reason nested one level down.
	Response *struct {
		Status string `json:"status"`
		Error  *struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
		IncompleteDetails *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
	} `json:"response"`
}

// ExtractStreamError reports the failure carried by one payload — a whole
// non-streamed body or a single SSE event.
//
// Deliberately strict: only a top-level error object, or an event that names
// itself an error, counts. Model output that merely talks about errors is a
// string inside `content`, never a top-level `error`, so it cannot trip this.
func ExtractStreamError(payload []byte) (StreamError, bool) {
	payload = trimLeadingSpace(payload)
	if len(payload) == 0 {
		return StreamError{}, false
	}
	// Gemini streams without `alt=sse` arrive as one JSON array of chunks, and
	// an array is also how some gateways report a batch failure. Each element
	// is scored on its own; this costs nothing on the hot path because a
	// non-streamed body is read once, at the end.
	if payload[0] == '[' {
		var chunks []json.RawMessage
		if err := json.Unmarshal(payload, &chunks); err != nil {
			return StreamError{}, false
		}
		for _, chunk := range chunks {
			if e, ok := ExtractStreamError(chunk); ok {
				return e, true
			}
		}
		return StreamError{}, false
	}
	// Only objects can carry an error in any dialect. Skipping bare values
	// keeps the unmarshal off the hot path for content chunks that could not
	// match anyway.
	if payload[0] != '{' {
		return StreamError{}, false
	}

	var raw rawStreamError
	if err := json.Unmarshal(payload, &raw); err != nil {
		return StreamError{}, false
	}

	if e := raw.Error; e != nil {
		out := StreamError{
			Message: strings.TrimSpace(e.Message),
			Type:    strings.TrimSpace(e.Type),
			Status:  statusFromJSON(e.Code, e.Status),
		}
		if out.Message == "" && out.Type == "" && out.Status == 0 {
			// `"error": null` and `"error": {}` are what a healthy OpenAI
			// chunk looks like; an empty object is not a failure report.
			return StreamError{}, false
		}
		if out.Message == "" {
			out.Message = describe(out.Type, out.Status)
		}
		return out, true
	}

	if resp := raw.Response; resp != nil {
		status := strings.TrimSpace(resp.Status)
		if status == "failed" || status == "incomplete" {
			out := StreamError{Type: status}
			switch {
			case resp.Error != nil && strings.TrimSpace(resp.Error.Message) != "":
				out.Message = strings.TrimSpace(resp.Error.Message)
			case resp.IncompleteDetails != nil && strings.TrimSpace(resp.IncompleteDetails.Reason) != "":
				out.Message = "response " + status + ": " + strings.TrimSpace(resp.IncompleteDetails.Reason)
			default:
				out.Message = "upstream reported response." + status
			}
			return out, true
		}
	}

	// An event that names itself an error but carries no error object at all.
	// Rare, and worth surfacing as "something failed" rather than silently
	// counting the call as a success.
	if t := strings.TrimSpace(raw.Type); t == "error" || strings.HasSuffix(t, ".error") {
		return StreamError{Type: t, Message: "upstream sent an error event"}, true
	}

	return StreamError{}, false
}

// statusFromJSON reads whichever of the two fields carries a number. Gemini
// puts the HTTP code in `code`; some gateways put a textual enum such as
// "RESOURCE_EXHAUSTED" there and the number in `status`, or vice versa.
func statusFromJSON(fields ...json.RawMessage) int {
	for _, field := range fields {
		var n int
		if len(field) > 0 && json.Unmarshal(field, &n) == nil && n >= 100 && n <= 599 {
			return n
		}
	}
	return 0
}

// describe builds a message for an error that reported a classification but no
// text, so the log never shows a failure with an empty reason.
func describe(errType string, status int) string {
	switch {
	case errType != "" && status != 0:
		return errType + " (HTTP " + itoa(status) + ")"
	case errType != "":
		return errType
	case status != 0:
		return "upstream reported HTTP " + itoa(status)
	}
	return "upstream reported an error"
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [8]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

func trimLeadingSpace(b []byte) []byte {
	for len(b) > 0 {
		switch b[0] {
		case ' ', '\t', '\r', '\n':
			b = b[1:]
		default:
			return b
		}
	}
	return b
}

// StreamErrorAccumulator keeps the first failure seen across a streamed
// response. The first one is the useful one: what follows is usually the
// upstream closing down, and a later generic "stream ended" would displace the
// reason the operator needs.
type StreamErrorAccumulator struct {
	err   StreamError
	found bool
}

// Feed scores one SSE payload, reporting whether this call recorded the error.
func (a *StreamErrorAccumulator) Feed(payload []byte) bool {
	if a.found {
		return false
	}
	e, ok := ExtractStreamError(payload)
	if !ok {
		return false
	}
	a.err, a.found = e, true
	return true
}

func (a *StreamErrorAccumulator) Result() (StreamError, bool) { return a.err, a.found }
