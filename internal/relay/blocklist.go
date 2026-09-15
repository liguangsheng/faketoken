package relay

import (
	"bytes"
	"fmt"
	"math/rand"
	"strings"
	"sync/atomic"
)

// Bounds on the policy. Matching runs on every relayed request, so the keyword
// budget is a total across every group rather than a per-group allowance:
// twenty groups of two hundred keywords each would be a way to make the
// gateway slow rather than a way to make it stricter.
const (
	// MaxBlockRules bounds how many groups may be defined.
	MaxBlockRules = 20
	// maxBlockedKeywords is the keyword budget shared by all groups.
	maxBlockedKeywords = 200
	maxKeywordLength   = 200
	// MaxRepliesPerRule bounds one group's reply pool.
	MaxRepliesPerRule = 20
	// maxRuleNameRunes bounds the label. It only ever appears in a log line,
	// so it needs to be readable rather than long.
	maxRuleNameRunes = 40
)

// BlockRule is one category of prompts to intercept — liveness probes,
// jailbreak attempts — together with the replies that category is answered
// from.
//
// Grouping is the point: the categories want different answers. A probe
// checking whether a key is alive expects something short and ordinary, while
// a jailbreak attempt is better answered with something entirely beside the
// point. A single flat list can only ever have one reply for both.
type BlockRule struct {
	// Name labels the group in the operator's log. It is never sent to a caller.
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Keywords match as case-insensitive substrings of the request body. They
	// are stored as typed, so the console shows the operator their own text;
	// folding happens once at compile time.
	Keywords []string `json:"keywords"`
	// Replies is the pool a match is answered from, one drawn per request.
	// Empty means the built-in default text.
	Replies []string `json:"replies"`
	// Status overrides the global default for this group; 0 inherits it. A
	// liveness probe and a jailbreak attempt may well deserve different
	// treatment, which is why this is per group and not only global.
	Status int `json:"status"`
}

// Defaults used when the operator has not chosen otherwise. 200 with a fixed
// text means a blocked caller sees an ordinary answer rather than an error,
// which is the point of answering instead of refusing.
const (
	DefaultBlockedStatus = 200
	// MaxBlockedReplyLength bounds one stored reply; it is returned in full on
	// every blocked request.
	MaxBlockedReplyLength = 8 << 10
)

// DefaultBlockedReply answers a group that has no reply of its own configured.
const DefaultBlockedReply = blockedReplyText

// BlockedLogPrefix marks a log row the block policy answered. The console
// matches on it to keep the group and the keyword away from the caller, who
// would otherwise be able to map the list one request at a time.
const BlockedLogPrefix = "blocked by rule"

// BlockedLogRedacted is what a caller's own log listing shows instead.
const BlockedLogRedacted = "blocked by this gateway's content policy"

// blocklist is the compiled policy, swapped atomically when the setting
// changes.
//
// The groups and the default status live in one value so a change is seen
// whole: swapping them separately would let a request match the new groups and
// be answered with the old status.
type blocklist struct {
	rules []compiledRule
	// status is the default a group inherits when it sets none of its own.
	status int
}

// compiledRule is one group with its keywords already folded, so matching does
// not have to lower-case them again on every request.
type compiledRule struct {
	name     string
	keywords []string
	replies  []string
	status   int
}

// blockHit describes what matched and how it is to be answered.
type blockHit struct {
	rule    string
	keyword string
	status  int
	reply   string
}

// logMessage is what the operator's log records: which group matched, and on
// which keyword. Never sent to the caller — a rejection that names the word
// that tripped it turns every request into a probe for mapping the list.
func (h blockHit) logMessage() string {
	return fmt.Sprintf("%s %q: keyword %q", BlockedLogPrefix, h.rule, h.keyword)
}

// NormalizeBlockRules cleans an operator-supplied set for storage.
//
// Blank keywords are dropped rather than kept: an empty keyword is a substring
// of every request, so one stray blank line would silently block all traffic.
// That failure mode is the reason this is a function with tests rather than a
// loop at the call site.
//
// The keyword budget is spent by stored keywords whether or not their group is
// enabled. Charging only enabled groups would mean toggling one group could
// silently drop keywords from another.
func NormalizeBlockRules(rules []BlockRule) []BlockRule {
	out := make([]BlockRule, 0, len(rules))
	budget := maxBlockedKeywords

	for _, rule := range rules {
		if len(out) >= MaxBlockRules {
			break
		}

		clean := BlockRule{
			Name:     truncateRunes(strings.TrimSpace(rule.Name), maxRuleNameRunes),
			Enabled:  rule.Enabled,
			Status:   rule.Status,
			Keywords: []string{},
			Replies:  []string{},
		}
		// 0 is the documented "inherit"; anything else out of range is a typo
		// that would otherwise be stored and quietly ignored per request.
		if clean.Status != 0 && !ValidBlockedStatus(clean.Status) {
			clean.Status = 0
		}

		seen := make(map[string]struct{}, len(rule.Keywords))
		for _, raw := range rule.Keywords {
			if budget <= 0 {
				break
			}
			word := strings.TrimSpace(raw)
			if word == "" || len(word) > maxKeywordLength {
				continue
			}
			// Deduplicated case-insensitively because that is how they match;
			// within one group only, so an earlier group keeps its claim on a
			// word a later one repeats.
			folded := strings.ToLower(word)
			if _, dup := seen[folded]; dup {
				continue
			}
			seen[folded] = struct{}{}
			clean.Keywords = append(clean.Keywords, word)
			budget--
		}

		for _, raw := range rule.Replies {
			if len(clean.Replies) >= MaxRepliesPerRule {
				break
			}
			reply := strings.TrimSpace(raw)
			if reply == "" || len(reply) > MaxBlockedReplyLength {
				continue
			}
			clean.Replies = append(clean.Replies, reply)
		}

		// A group with no name, no keyword and no reply is a row somebody added
		// and never filled in. Keeping it only clutters the form.
		if clean.Name == "" && len(clean.Keywords) == 0 && len(clean.Replies) == 0 {
			continue
		}
		out = append(out, clean)
	}
	return out
}

// truncateRunes cuts to a rune count rather than a byte count, so a Chinese
// name is not left ending in half a character.
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// compileBlockRules drops what cannot match and folds what can.
//
// A disabled group and a group with no keywords are both skipped here rather
// than checked per request: the hot path should only walk groups that can
// actually produce a hit.
func compileBlockRules(rules []BlockRule) []compiledRule {
	out := make([]compiledRule, 0, len(rules))
	for i, rule := range rules {
		if !rule.Enabled || len(rule.Keywords) == 0 {
			continue
		}
		folded := make([]string, 0, len(rule.Keywords))
		for _, word := range rule.Keywords {
			folded = append(folded, strings.ToLower(word))
		}
		// An unnamed group still has to be identifiable in the log; its
		// position in the form is the only handle left.
		name := rule.Name
		if name == "" {
			name = fmt.Sprintf("规则 %d", i+1)
		}
		out = append(out, compiledRule{
			name:     name,
			keywords: folded,
			replies:  rule.Replies,
			status:   rule.Status,
		})
	}
	return out
}

// SetBlockPolicy replaces the groups and the default status without a restart.
// An out-of-range default falls back rather than producing a response nobody
// asked for.
func (rl *Relay) SetBlockPolicy(rules []BlockRule, defaultStatus int) {
	if !ValidBlockedStatus(defaultStatus) {
		defaultStatus = DefaultBlockedStatus
	}
	rl.blocked.Store(&blocklist{
		rules:  compileBlockRules(NormalizeBlockRules(rules)),
		status: defaultStatus,
	})
}

// ValidBlockedStatus accepts anything an HTTP client will understand as a
// status. Narrower than that would rule out codes an operator may have a
// reason for; wider would let a typo produce an unparseable response.
func ValidBlockedStatus(status int) bool { return status >= 200 && status <= 599 }

// pickReply draws one of the group's replies.
//
// Random rather than a rotation: whoever sends the same probe twice is exactly
// who this is hiding from, and a fixed order is a pattern they can read. Two
// draws may repeat, which is what an ordinary model would do anyway.
func (r compiledRule) pickReply() string {
	switch len(r.replies) {
	case 0:
		return DefaultBlockedReply
	case 1:
		return r.replies[0]
	default:
		return r.replies[rand.Intn(len(r.replies))]
	}
}

func (r compiledRule) statusOr(fallback int) int {
	if ValidBlockedStatus(r.status) {
		return r.status
	}
	return fallback
}

// matchBlocked reports the first group whose keyword appears in the request
// body, along with the reply and status that group is answered with.
//
// The body is folded once and reused across every keyword. That costs one
// allocation the size of the request, which is why an empty policy returns
// before touching it — a deployment with no groups pays nothing.
//
// Groups are walked in the operator's own order, so a word claimed by two of
// them is answered by the one listed first.
func (rl *Relay) matchBlocked(body []byte) (blockHit, bool) {
	list := rl.blocked.Load()
	if list == nil || len(list.rules) == 0 || len(body) == 0 {
		return blockHit{}, false
	}
	folded := bytes.ToLower(body)
	for _, rule := range list.rules {
		for _, word := range rule.keywords {
			if bytes.Contains(folded, []byte(word)) {
				return blockHit{
					rule:    rule.name,
					keyword: word,
					status:  rule.statusOr(list.status),
					reply:   rule.pickReply(),
				}, true
			}
		}
	}
	return blockHit{}, false
}

// blockedStore is the atomic holder; declared here to keep the field and its
// meaning in one file.
type blockedStore = atomic.Pointer[blocklist]
