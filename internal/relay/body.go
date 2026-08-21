package relay

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// requestInfo is everything the router needs to know about a client payload.
// Anything not listed here is forwarded untouched.
type requestInfo struct {
	Model  string
	Stream bool
	IsJSON bool
}

func inspect(path, contentType string, body []byte) requestInfo {
	info := requestInfo{
		IsJSON: strings.Contains(strings.ToLower(contentType), "json"),
	}

	// Gemini carries the model in the URL: /v1beta/models/<model>:generateContent
	if strings.Contains(path, "/models/") && strings.Contains(path, ":") {
		info.Model = geminiModelFromPath(path)
		info.Stream = strings.Contains(path, ":streamGenerateContent") ||
			strings.Contains(path, ":streamGenerateAnswer")
	}

	if info.IsJSON && len(body) > 0 {
		var probe struct {
			Model  string `json:"model"`
			Stream *bool  `json:"stream"`
		}
		if err := json.Unmarshal(body, &probe); err == nil {
			if probe.Model != "" {
				info.Model = probe.Model
			}
			if probe.Stream != nil {
				info.Stream = *probe.Stream
			}
		}
	}

	// Multipart uploads (audio transcriptions) keep the model in a form field.
	if info.Model == "" && strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		info.Model = multipartModel(body)
	}
	return info
}

func geminiModelFromPath(path string) string {
	idx := strings.Index(path, "/models/")
	if idx < 0 {
		return ""
	}
	rest := path[idx+len("/models/"):]
	if colon := strings.IndexByte(rest, ':'); colon >= 0 {
		rest = rest[:colon]
	}
	if slash := strings.IndexByte(rest, '/'); slash >= 0 {
		rest = rest[:slash]
	}
	return rest
}

// multipartModel does a cheap scan for the `model` form field rather than
// parsing (and thereby buffering a second copy of) the whole upload.
func multipartModel(body []byte) string {
	marker := []byte(`name="model"`)
	idx := bytes.Index(body, marker)
	if idx < 0 {
		return ""
	}
	rest := body[idx+len(marker):]
	sep := []byte("\r\n\r\n")
	start := bytes.Index(rest, sep)
	if start < 0 {
		sep = []byte("\n\n")
		if start = bytes.Index(rest, sep); start < 0 {
			return ""
		}
	}
	rest = rest[start+len(sep):]
	end := bytes.IndexByte(rest, '\r')
	if end < 0 {
		if end = bytes.IndexByte(rest, '\n'); end < 0 {
			end = len(rest)
		}
	}
	return strings.TrimSpace(string(rest[:end]))
}

// hasConversationAttachment reports whether a JSON conversation payload
// contains non-text user input. It intentionally recognises the common shapes
// across Messages, Chat Completions, Responses and Gemini without treating
// tool calls/results, thinking blocks or ordinary metadata as attachments.
func hasConversationAttachment(contentType string, body []byte) bool {
	if !strings.Contains(strings.ToLower(contentType), "json") || len(body) == 0 {
		return false
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err != nil {
		return false
	}
	return attachmentValue(payload, "")
}

var attachmentTypes = map[string]bool{
	"image": true, "image_url": true, "input_image": true,
	"document": true, "file": true, "input_file": true,
	"audio": true, "input_audio": true,
	"video": true, "input_video": true,
	"inline_data": true, "file_data": true,
}

func attachmentValue(value any, parentKey string) bool {
	switch typed := value.(type) {
	case []any:
		if parentKey == "attachments" || parentKey == "files" || parentKey == "images" {
			return len(typed) > 0
		}
		for _, item := range typed {
			if attachmentValue(item, parentKey) {
				return true
			}
		}
	case map[string]any:
		if typ, _ := typed["type"].(string); attachmentTypes[strings.ToLower(strings.TrimSpace(typ))] {
			return true
		}
		for key, item := range typed {
			normalized := strings.ToLower(strings.TrimSpace(key))
			switch normalized {
			case "image_url", "input_audio", "inline_data", "inlinedata", "file_data", "filedata":
				if item != nil {
					return true
				}
			case "attachments", "files", "images":
				if attachmentValue(item, normalized) {
					return true
				}
			default:
				if attachmentValue(item, normalized) {
					return true
				}
			}
		}
	}
	return false
}

// rewriteModel swaps the top-level "model" value while leaving every other
// byte of the payload exactly as the client sent it. Falls back to a
// re-encode only if the splice is not possible.
func rewriteModel(body []byte, newModel string) []byte {
	if spliced, ok := spliceTopLevelString(body, "model", newModel); ok {
		return spliced
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(body, &obj); err != nil {
		return body
	}
	encoded, err := json.Marshal(newModel)
	if err != nil {
		return body
	}
	obj["model"] = encoded
	out, err := json.Marshal(obj)
	if err != nil {
		return body
	}
	return out
}

// spliceTopLevelString locates the byte range of a top-level key's value and
// replaces just those bytes, preserving key order, whitespace and the exact
// formatting of every other field.
func spliceTopLevelString(body []byte, key, value string) ([]byte, bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	tok, err := dec.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := tok.(json.Delim); !ok || delim != '{' {
		return nil, false
	}

	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, false
		}
		name, ok := keyTok.(string)
		if !ok {
			return nil, false
		}
		afterKey := dec.InputOffset()

		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, false
		}
		end := dec.InputOffset()

		if name != key {
			continue
		}
		// Skip the colon and any padding between key and value.
		start := afterKey
		for start < end && isJSONSpace(body[start]) {
			start++
		}
		if start >= end || body[start] != ':' {
			return nil, false
		}
		start++
		for start < end && isJSONSpace(body[start]) {
			start++
		}

		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, false
		}
		out := make([]byte, 0, len(body)-int(end-start)+len(encoded))
		out = append(out, body[:start]...)
		out = append(out, encoded...)
		out = append(out, body[end:]...)
		return out, true
	}
	return nil, false
}

func isJSONSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r'
}

// protocolFromPath maps a client request path to the upstream dialect it
// speaks. The router uses this to skip channels that advertise only a subset.
// Gemini's path carries no "protocol" in this sense — it routes by model, and
// every channel that serves the model already accepts the Gemini dialect — so
// it returns "" and the protocol filter is skipped.
func protocolFromPath(path string) string {
	switch {
	case strings.Contains(path, "/v1/messages"):
		return model.ProtocolMessages
	case strings.Contains(path, "/v1/responses"):
		return model.ProtocolResponses
	case strings.HasSuffix(path, "/chat/completions"),
		strings.HasSuffix(path, "/completions"):
		return model.ProtocolChatCompletions
	}
	return ""
}
