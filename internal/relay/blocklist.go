package relay

import (
	"bytes"
	"strings"
	"sync/atomic"
)

// maxBlockedKeywords and maxKeywordLength bound the list. Matching runs on
// every relayed request, so an unbounded list would be a way to make the
// gateway slow rather than a way to make it stricter.
const (
	maxBlockedKeywords = 200
	maxKeywordLength   = 200
)

// blocklist is the compiled policy, swapped atomically when the setting
// changes. Keywords are stored lowercased so matching does not have to fold
// them again on every request.
//
// Keywords and the response they produce live in one value so a change is seen
// whole: swapping them separately would let a request match the new list and
// be answered with the old status.
type blocklist struct {
	keywords []string
	status   int
	reply    string
}

// Defaults used when the operator has not chosen otherwise. 200 with a fixed
// text means a blocked caller sees an ordinary answer rather than an error,
// which is the point of answering instead of refusing.
const (
	DefaultBlockedStatus = 200
	// MaxBlockedReplyLength bounds the stored text; it is returned in full on
	// every blocked request.
	MaxBlockedReplyLength = 8 << 10
)

// DefaultBlockedReply is what a blocked request is answered with when no
// replacement has been configured.
const DefaultBlockedReply = blockedReplyText

// ParseKeywords cleans an operator-supplied list, one keyword per line.
//
// Blank entries are dropped rather than kept: an empty keyword is a substring
// of every request, so a single stray blank line would silently block all
// traffic. That failure mode is the reason this is a function with tests
// rather than a split() at the call site.
func ParseKeywords(raw string) []string {
	seen := make(map[string]struct{})
	out := make([]string, 0, 8)
	for _, line := range strings.Split(raw, "\n") {
		word := strings.ToLower(strings.TrimSpace(line))
		if word == "" || len(word) > maxKeywordLength {
			continue
		}
		if _, dup := seen[word]; dup {
			continue
		}
		seen[word] = struct{}{}
		out = append(out, word)
		if len(out) >= maxBlockedKeywords {
			break
		}
	}
	return out
}

// SetBlockPolicy replaces the keyword list and what a match is answered with,
// without a restart. An out-of-range status or an empty reply falls back to the
// default rather than producing a response nobody asked for.
func (rl *Relay) SetBlockPolicy(keywords []string, status int, reply string) {
	if !ValidBlockedStatus(status) {
		status = DefaultBlockedStatus
	}
	if strings.TrimSpace(reply) == "" {
		reply = DefaultBlockedReply
	}
	rl.blocked.Store(&blocklist{keywords: keywords, status: status, reply: reply})
}

// ValidBlockedStatus accepts anything an HTTP client will understand as a
// status. Narrower than that would rule out codes an operator may have a
// reason for; wider would let a typo produce an unparseable response.
func ValidBlockedStatus(status int) bool { return status >= 200 && status <= 599 }

// blockedResponse reports how a match should be answered.
func (rl *Relay) blockedResponse() (int, string) {
	if list := rl.blocked.Load(); list != nil && list.status > 0 {
		return list.status, list.reply
	}
	return DefaultBlockedStatus, DefaultBlockedReply
}

// matchBlocked reports the first keyword found in the request body, or "" when
// the body is clean.
//
// The body is folded once and reused across keywords. That costs one
// allocation the size of the request, which is why the empty list returns
// before touching it — a deployment with no keywords pays nothing.
func (rl *Relay) matchBlocked(body []byte) string {
	list := rl.blocked.Load()
	if list == nil || len(list.keywords) == 0 || len(body) == 0 {
		return ""
	}
	folded := bytes.ToLower(body)
	for _, word := range list.keywords {
		if bytes.Contains(folded, []byte(word)) {
			return word
		}
	}
	return ""
}

// blockedStore is the atomic holder; declared here to keep the field and its
// meaning in one file.
type blockedStore = atomic.Pointer[blocklist]
