package upstream

import (
	"encoding/json"
	"strings"
)

// ErrorMessage pulls the human-readable reason out of an error body. Both the
// OpenAI shape ({"error":{"message":...}}) and the bare {"message":...} are
// read; anything else is returned as text, bounded so a stray HTML page does
// not end up in a log column.
func ErrorMessage(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	var payload struct {
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
		} `json:"error"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.Error.Message != "" {
			return payload.Error.Message
		}
		if payload.Message != "" {
			return payload.Message
		}
	}
	if len(body) > 500 {
		body = body[:500]
	}
	return strings.TrimSpace(string(body))
}
