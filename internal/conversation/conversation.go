// Package conversation reads what a relayed request says about the
// conversation it belongs to: the session the client named, and the messages
// it carries, one hash each. Pure functions over headers and bytes; the relay
// calls them and the store keeps what they return.
//
// A coding agent resends its whole conversation on every turn, so a request
// is the previous one plus a message or two. Comparing message hashes from the
// start is how a call is matched to the one it continues.
package conversation

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
)

// sessionHeaders are where clients name their session, most specific first.
// Claude Code sends X-Claude-Code-Session-Id; pi and Codex send session_id,
// which net/http files as Session_id.
var sessionHeaders = []string{
	"X-Claude-Code-Session-Id",
	"Session_id",
	"Session-Id",
	"X-Session-Id",
	"Conversation_id",
	"Conversation-Id",
}

// maxSessionID bounds a stored id. A UUID is 36 characters.
const maxSessionID = 128

// SessionID returns the session the caller named, or "". The id ends up in a
// URL path, so one that is not plain is replaced by a digest of itself:
// "a/b c" → "h:" + 16 hex digits, still one id per session.
func SessionID(h http.Header) string {
	for _, name := range sessionHeaders {
		id := strings.TrimSpace(h.Get(name))
		if id == "" {
			continue
		}
		if len(id) > maxSessionID || strings.IndexFunc(id, notPlain) >= 0 {
			sum := sha256.Sum256([]byte(id))
			return "h:" + hex.EncodeToString(sum[:8])
		}
		return id
	}
	return ""
}

// notPlain reports a rune outside the URL-safe set ids are kept to.
func notPlain(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return false
	}
	return !strings.ContainsRune("-._:@", r)
}

// maxDecode bounds the body decoded for its messages. Decoding peaks at
// several times the body in memory, and past this the link is not worth it.
const maxDecode = 32 << 20

// Messages hashes each message of a conversation request, in order: the
// Messages and chat-completions `messages`, Gemini's `contents`, or a
// Responses `input` list. Nil when the body is not a conversation — not JSON,
// no list, or a list of something other than objects, the way an embeddings
// request uses `input`.
func Messages(body []byte) []int64 {
	if len(body) == 0 || len(body) > maxDecode {
		return nil
	}
	var root struct {
		Messages json.RawMessage `json:"messages"`
		Contents json.RawMessage `json:"contents"`
		Input    json.RawMessage `json:"input"`
	}
	if json.Unmarshal(body, &root) != nil {
		return nil
	}
	list := root.Messages
	if len(list) == 0 {
		list = root.Contents
	}
	if len(list) == 0 {
		list = root.Input
	}

	var items []json.RawMessage
	if json.Unmarshal(list, &items) != nil || len(items) == 0 {
		return nil
	}
	out := make([]int64, len(items))
	for i, item := range items {
		if !bytes.HasPrefix(bytes.TrimSpace(item), []byte("{")) {
			return nil
		}
		out[i] = hash(item)
	}
	return out
}

// hash names one message by its content, ignoring where the client put its
// cache breakpoints: Claude Code moves cache_control to the newest messages
// every turn, and a message must not read as new because the marker left it.
// Keys are re-encoded sorted, so the layout of the body does not matter
// either.
func hash(raw json.RawMessage) int64 {
	canonical := []byte(raw)
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var value any
	if dec.Decode(&value) == nil {
		stripCacheControl(value)
		if encoded, err := json.Marshal(value); err == nil {
			canonical = encoded
		}
	}
	sum := sha256.Sum256(canonical)
	return int64(binary.BigEndian.Uint64(sum[:8]))
}

func stripCacheControl(value any) {
	switch item := value.(type) {
	case map[string]any:
		delete(item, "cache_control")
		for _, child := range item {
			stripCacheControl(child)
		}
	case []any:
		for _, child := range item {
			stripCacheControl(child)
		}
	}
}

// Shared counts the messages two calls have in common from the start:
// Shared([a b c], [a b x y]) == 2.
func Shared(a, b []int64) int {
	n := min(len(a), len(b))
	for i := range n {
		if a[i] != b[i] {
			return i
		}
	}
	return n
}
