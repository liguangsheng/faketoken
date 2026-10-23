// Package redact renders a captured request or response for the log: bounded
// to a size, with credentials replaced, and reduced to a note when the bytes
// are binary or too large to be worth reading back.
package redact

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"sort"
	"strings"
)

// DefaultCaptureLimit is how much of a request or response is kept for the
// full-log view. Models now take million-token contexts, which run to several
// megabytes of JSON, so an exchange has to be captured at that scale to be
// worth reading back.
const DefaultCaptureLimit = 4 << 20

// Headers copies headers with credentials removed. Sorted so a stored record
// reads the same way twice, and bounded so a pathological client cannot turn
// one request into an unbounded row.
func Headers(headers http.Header) map[string][]string {
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
		if SensitiveHeader(canonical) {
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

// SensitiveHeader reports whether a header carries a credential, judged by its
// name. Matched on parts rather than a list of names, because upstreams invent
// their own (Ocp-Apim-Subscription-Key, X-Token), and it errs towards hiding: a
// request id lost to redaction costs less than a key kept in the clear.
func SensitiveHeader(name string) bool {
	normalized := strings.ToLower(strings.ReplaceAll(name, "-", ""))
	for _, part := range []string{"auth", "key", "token", "secret", "cookie", "password"} {
		if strings.Contains(normalized, part) {
			return true
		}
	}
	return false
}

// Body renders a body for storage: truncated to the limit, redacted, and
// reduced to a note when it is binary or too large to be useful. The second
// result reports whether anything was cut, including by the caller before
// the bytes got here.
func Body(contentType string, body []byte, alreadyTruncated bool, limit int) (string, bool) {
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
				return capString(string(encoded), truncated, limit)
			}
		}
	}

	if strings.Contains(mediaType, "event-stream") {
		return capString(eventStream(body, truncated), truncated, limit)
	}
	if !isTextMediaType(mediaType) {
		return fmt.Sprintf("[binary body omitted: %d bytes, content-type %s]", originalSize, mediaType), truncated
	}
	return capString(strings.ToValidUTF8(string(body), "?"), truncated, limit)
}

// capString bounds the rendered form. Re-indenting JSON can push a body past
// the limit that was applied to the raw bytes, so the result is measured again
// rather than assumed to still fit.
func capString(value string, truncated bool, limit int) (string, bool) {
	if limit <= 0 || len(value) <= limit {
		return value, truncated
	}
	// Cut on the byte limit, then drop whatever partial rune the cut left
	// behind so the stored text stays valid UTF-8.
	return strings.ToValidUTF8(value[:limit], "") + "...[TRUNCATED]", true
}

// eventStream redacts each SSE data frame in place, leaving the frame
// structure intact so the stream still reads as a stream.
func eventStream(body []byte, truncated bool) string {
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
