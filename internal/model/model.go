// Package model holds the domain types shared by the store, API and relay layers.
package model

import (
	"encoding/json"
	"slices"
	"sort"
	"strings"
	"time"
)

// Roles.
const (
	RoleUser  = 1
	RoleAdmin = 100
)

// Status values shared by users, tokens and channels.
const (
	StatusEnabled  = 1
	StatusDisabled = 2
)

// Channel authentication styles. Auto derives the credential header from the
// request endpoint; the explicit values cover unusual compatible gateways.
const (
	AuthStyleAuto        = "auto"
	AuthStyleBearer      = "bearer"
	AuthStyleXAPIKey     = "x-api-key"
	AuthStyleXGoogAPIKey = "x-goog-api-key"
)

// Supported upstream protocols. A channel advertises the subset it actually
// answers; empty (or all three) keeps the original "route every dialect"
// behaviour.
const (
	ProtocolChatCompletions = "chat_completions"
	ProtocolResponses       = "responses"
	ProtocolMessages        = "messages"
)

// AllProtocols lists every known upstream dialect.
var AllProtocols = []string{ProtocolChatCompletions, ProtocolResponses, ProtocolMessages}

// ValidProtocol reports whether p names one of AllProtocols.
func ValidProtocol(p string) bool { return slices.Contains(AllProtocols, p) }

// Routable reports whether the channel may serve traffic at all. It is what the
// routing tables' enabled flag is derived from, so an archived channel cannot
// be reached however its status column reads.
func (c *Channel) Routable() bool {
	return c.Status == StatusEnabled && !c.Archived
}

type User struct {
	ID           int64     `json:"id"`
	Username     string    `json:"username"`
	DisplayName  string    `json:"display_name"`
	Email        string    `json:"email"`
	Role         int16     `json:"role"`
	Status       int16     `json:"status"`
	Group        string    `json:"group"`
	Quota        int64     `json:"quota"`      // remaining balance, micro-USD
	UsedQuota    int64     `json:"used_quota"` // lifetime spend, micro-USD
	RequestCount int64     `json:"request_count"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`

	PasswordHash string `json:"-"`
	// TokenVersion is signed into every session token; a token carrying any
	// other value is refused. Changing the password bumps it.
	TokenVersion int32 `json:"-"`
}

func (u *User) IsAdmin() bool { return u.Role >= RoleAdmin }

type UserGroup struct {
	Name        string  `json:"name"`
	Rate        float64 `json:"rate"`
	Description string  `json:"description"`
	// UserSelectable lets a regular account point one of its own keys at this
	// group. Closed by default: a group carries both channel access and a
	// price multiplier, so opening one is a deliberate decision.
	UserSelectable bool      `json:"user_selectable"`
	CreatedAt      time.Time `json:"created_at"`
}

type Token struct {
	ID             int64  `json:"id"`
	UserID         int64  `json:"user_id"`
	Name           string `json:"name"`
	KeyPrefix      string `json:"key_prefix"`
	Status         int16  `json:"status"`
	UnlimitedQuota bool   `json:"unlimited_quota"`
	Quota          int64  `json:"quota"`
	UsedQuota      int64  `json:"used_quota"`
	// RPMLimit caps how many requests this key may make per minute. 0 means
	// unlimited. Enforced at the relay before any routing happens.
	RPMLimit      int32    `json:"rpm_limit"`
	AllowedModels []string `json:"allowed_models"`
	// Group routes and prices this key. Empty follows the owning account's
	// group, which is how every key behaved before this field existed.
	Group      string     `json:"group"`
	ExpiresAt  *time.Time `json:"expires_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`

	KeyHash string `json:"-"`
	// Key is the plaintext, filled in only by the endpoint that deliberately
	// reveals it. Listing keys never populates it.
	Key string `json:"key,omitempty"`
}

type Channel struct {
	ID        int64    `json:"id"`
	Name      string   `json:"name"`
	BaseURL   string   `json:"base_url"`
	AuthStyle string   `json:"auth_style"`
	Status    int16    `json:"status"`
	Priority  int32    `json:"priority"`
	Weight    int32    `json:"weight"`
	Groups    []string `json:"groups"`
	Models    []string `json:"models"`
	// ModelPrefixes route a whole family ("gpt-4") without enumerating every
	// snapshot name. They are only consulted when no exact model matches.
	ModelPrefixes []string          `json:"model_prefixes"`
	ModelMapping  map[string]string `json:"model_mapping"`
	Headers       map[string]string `json:"headers"`
	TimeoutSecs   int32             `json:"timeout_secs"`
	ProxyURL      string            `json:"proxy_url"`
	PriceRatio    float64           `json:"price_ratio"`
	// RPMLimit caps how many requests the channel may serve per minute. 0
	// means unlimited; a channel left at 0 has no rate limiting applied.
	RPMLimit int32 `json:"rpm_limit"`
	// RetryCount is how many extra attempts this channel gets before the
	// request moves on to another one, on top of the global max_retries, which
	// caps how many channels a request may visit. 0 is the old behaviour: one
	// shot per channel.
	RetryCount int32 `json:"retry_count"`
	// RetryBackoffMS is the base delay between this channel's own retries, in
	// milliseconds, scaled by the attempt number. 0 inherits the global retry
	// interval.
	RetryBackoffMS int32      `json:"retry_backoff_ms"`
	UsedQuota      int64      `json:"used_quota"`
	RequestCount   int64      `json:"request_count"`
	ErrorCount     int64      `json:"error_count"`
	LastError      string     `json:"last_error"`
	LastErrorAt    *time.Time `json:"last_error_at"`
	TestedAt       *time.Time `json:"tested_at"`
	ModelsSyncedAt *time.Time `json:"models_synced_at"`
	// TestModel is what the console probe sends. Empty falls back to the first
	// served model, which is meaningless for a prefix-only channel.
	TestModel string `json:"test_model"`
	// SupportedProtocols is the set of upstream dialects the channel answers.
	// The probe narrows it; the operator can edit it. Empty means every
	// dialect, so an old channel keeps routing as it did before the column
	// existed.
	SupportedProtocols []string `json:"supported_protocols"`
	// ReasoningEffortMapping renames the thinking level a caller asked for into
	// the one this upstream accepts ("max" -> "xhigh"), per model.
	//
	// The outer key selects which models a table of renames applies to: "*" is
	// every model the channel serves, "gpt-5*" every model whose name starts
	// that way, and a bare name only itself. Inner keys are lowercase levels; an
	// empty map forwards whatever the client sent. Use EffortMappingFor to
	// resolve it for one model rather than reading it directly.
	ReasoningEffortMapping EffortMapping `json:"reasoning_effort_mapping"`
	// StatusCodeMapping rewrites the status the caller is answered with when
	// this upstream fails: {429: 503} turns its rate limit into a plain
	// "unavailable". Only what the caller sees changes — retries, the breaker
	// and billing still read the upstream's own code. Use MappedStatus to
	// resolve it.
	StatusCodeMapping map[int]int `json:"status_code_mapping"`
	// AllowAttachments controls whether multimodal conversation content such
	// as images, documents, files and audio may be sent through this channel.
	AllowAttachments bool `json:"allow_attachments"`
	// LockUserAgent enables automatic learning when an upstream protocol has no
	// configured User-Agent. LockedUserAgents itself is always effective: its
	// values may be entered manually or learned after a successful request.
	LockUserAgent    bool              `json:"lock_user_agent"`
	LockedUserAgents map[string]string `json:"locked_user_agents"`
	// Archived retires the channel without deleting it: it leaves the main
	// listing for a collapsed section and keeps its configuration and history.
	//
	// Archiving always disables, so an archived channel can never keep serving
	// traffic while hidden from view. Separate from Status because "retired"
	// and "temporarily off" are different states — unarchiving brings the row
	// back to the listing but leaves it disabled, so returning a channel to
	// rotation stays a deliberate second step.
	Archived  bool      `json:"archived"`
	Note      string    `json:"note"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`

	// Keepalive opens the channel on a daily schedule and closes it again once
	// it has served KeepaliveTarget successful requests, for upstreams that
	// reclaim an account which sees no traffic. The successes are ordinary
	// relayed traffic: opening the channel is what lets routing reach it.
	KeepaliveEnabled bool `json:"keepalive_enabled"`
	// KeepaliveAt is "HH:MM" in the server's local zone.
	KeepaliveAt     string `json:"keepalive_at"`
	KeepaliveTarget int32  `json:"keepalive_target"`
	// KeepaliveOpen reports whether a window is currently counting. Separate
	// from KeepaliveOpenedAt, which is kept after the window closes so the
	// scheduler knows today's run already happened.
	KeepaliveOpen     bool       `json:"keepalive_open"`
	KeepaliveSuccess  int32      `json:"keepalive_success"`
	KeepaliveOpenedAt *time.Time `json:"keepalive_opened_at"`

	// APIKey is decrypted on read and masked before leaving the API layer.
	APIKey string `json:"api_key,omitempty"`
}

// UpstreamModel resolves the client-facing model name to the upstream one.
func (c *Channel) UpstreamModel(requested string) string {
	if c.ModelMapping != nil {
		if mapped, ok := c.ModelMapping[requested]; ok && mapped != "" {
			return mapped
		}
	}
	return requested
}

// MappedStatus is the status the caller should see for an upstream error, or
// 0 when no rule rewrites it. Success codes are never rewritten: the bytes
// behind them are a real answer, and calling it an error would be a lie.
func (c *Channel) MappedStatus(upstream int) int {
	if upstream < 400 {
		return 0
	}
	if to, ok := c.StatusCodeMapping[upstream]; ok && to != upstream {
		return to
	}
	return 0
}

// EffortMapping is a channel's thinking-level vocabulary, keyed by which models
// each table of renames applies to.
type EffortMapping map[string]map[string]string

// UnmarshalJSON accepts both shapes: the per-model tables written now, and the
// single flat table of renames written before there was a selector, which is
// read as "*" — the same thing it meant when it was the only option.
//
// This is what lets a stored row that predates the migration, or a script still
// posting the old shape, keep working instead of failing to decode.
func (m *EffortMapping) UnmarshalJSON(data []byte) error {
	var nested map[string]map[string]string
	if err := json.Unmarshal(data, &nested); err == nil {
		*m = nested
		return nil
	}

	var flat map[string]string
	if err := json.Unmarshal(data, &flat); err != nil {
		// Report the nested shape's failure: that is the one being written now,
		// so it is the error worth reading.
		return json.Unmarshal(data, &nested)
	}
	if len(flat) == 0 {
		*m = EffortMapping{}
		return nil
	}
	*m = EffortMapping{"*": flat}
	return nil
}

// NormaliseList trims each entry, drops the blank ones and the repeats, and
// keeps first-seen order. Never nil, so a caller can store or encode the
// result as an empty list rather than a null.
func NormaliseList(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, v := range in {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		out = append(out, v)
	}
	return out
}

// NormaliseEffortMapping folds every rule into the form the lookup expects and
// drops the incomplete ones.
//
// Levels are matched case-insensitively, so storing them lowercased is what
// lets the lookup be a plain map read on the hot path. Selectors keep their
// case: they are model names, and those are not case-insensitive.
func NormaliseEffortMapping(in EffortMapping) EffortMapping {
	out := make(EffortMapping, len(in))
	for selector, rules := range in {
		selector = strings.TrimSpace(selector)
		if selector == "" {
			continue
		}
		clean := make(map[string]string, len(rules))
		for from, to := range rules {
			from = strings.ToLower(strings.TrimSpace(from))
			to = strings.TrimSpace(to)
			if from == "" || to == "" {
				continue
			}
			clean[from] = to
		}
		// A selector left with no rules is a group the operator emptied out;
		// keeping it would park an invisible heading in the form forever.
		if len(clean) == 0 {
			continue
		}
		out[selector] = clean
	}
	return out
}

// EffortMappingFor resolves the thinking-level rules that apply to one model.
//
// Selectors are merged rather than replaced: a model's own table overrides the
// same level coming from a wider selector, and levels it says nothing about
// still come from there. That is what lets "*" carry the channel's usual
// vocabulary while a single model spells one level differently, without having
// to restate the rest.
//
// Specificity decides who wins: the exact name first, then the longest matching
// prefix, then "*" (which is simply the empty prefix).
//
// The model name is the one the caller asked for, not the one a model mapping
// rewrites it to — that is the name the operator sees everywhere else.
func (c *Channel) EffortMappingFor(requested string) map[string]string {
	if len(c.ReasoningEffortMapping) == 0 {
		return nil
	}

	type match struct {
		// rank is the prefix length, so a longer prefix wins; an exact name is
		// ranked above every prefix.
		rank  int
		rules map[string]string
	}
	var matches []match
	for selector, rules := range c.ReasoningEffortMapping {
		if len(rules) == 0 {
			continue
		}
		switch {
		case selector == requested:
			matches = append(matches, match{rank: exactEffortRank, rules: rules})
		case strings.HasSuffix(selector, "*"):
			prefix := strings.TrimSuffix(selector, "*")
			if strings.HasPrefix(requested, prefix) {
				matches = append(matches, match{rank: len(prefix), rules: rules})
			}
		}
	}

	switch len(matches) {
	case 0:
		return nil
	case 1:
		// The ordinary case — one "*" table, or one model's own — and the relay
		// consults this per request, so it must not copy a map to answer it.
		return matches[0].rules
	}

	sort.SliceStable(matches, func(i, j int) bool { return matches[i].rank < matches[j].rank })
	merged := make(map[string]string, len(matches[0].rules))
	for _, m := range matches {
		for from, to := range m.rules {
			merged[from] = to
		}
	}
	return merged
}

// exactEffortRank outranks every prefix; a model name is never this long.
const exactEffortRank = 1 << 30

// Candidate is the slim projection used by the routing hot path.
type Candidate struct {
	ChannelID int64
	Priority  int32
	Weight    int32
	RPMLimit  int32
}

type ChannelModel struct {
	ChannelID int64     `json:"channel_id"`
	Model     string    `json:"model"`
	FetchedAt time.Time `json:"fetched_at"`
}

type ModelPrice struct {
	Model           string    `json:"model"`
	InputPrice      float64   `json:"input_price"`
	OutputPrice     float64   `json:"output_price"`
	CachedPrice     float64   `json:"cached_price"`
	PerRequestPrice float64   `json:"per_request_price"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type RequestLog struct {
	ID            int64     `json:"id"`
	CreatedAt     time.Time `json:"created_at"`
	UserID        int64     `json:"user_id"`
	Username      string    `json:"username"`
	TokenID       int64     `json:"token_id"`
	TokenName     string    `json:"token_name"`
	ChannelID     int64     `json:"channel_id"`
	ChannelName   string    `json:"channel_name"`
	Model         string    `json:"model"`
	UpstreamModel string    `json:"upstream_model"`
	Endpoint      string    `json:"endpoint"`
	Method        string    `json:"method"`
	StatusCode    int32     `json:"status_code"`
	// UpstreamStatus is what the upstream actually answered when a channel's
	// status mapping rewrote it into StatusCode; 0 when no rule fired. Routing
	// internals, like UpstreamModel: only an administrator is shown it.
	UpstreamStatus   int32 `json:"upstream_status"`
	Stream           bool  `json:"stream"`
	PromptTokens     int32 `json:"prompt_tokens"`
	CompletionTokens int32 `json:"completion_tokens"`
	// CachedTokens are prompt tokens served from cache; CacheCreationTokens
	// are the ones written into it. Both are already counted in PromptTokens.
	CachedTokens        int32 `json:"cached_tokens"`
	CacheCreationTokens int32 `json:"cache_creation_tokens"`
	// PromptEstimated marks PromptTokens as estimated from the request body,
	// because the upstream reported zero input.
	PromptEstimated bool `json:"prompt_estimated"`
	// Cancelled marks a call its caller hung up on or an operator stopped:
	// recorded with whatever error that produced, but not the channel's fault.
	Cancelled   bool   `json:"cancelled"`
	TotalTokens int32  `json:"total_tokens"`
	Cost        int64  `json:"cost"`
	DurationMS  int32  `json:"duration_ms"`
	TTFBMS      int32  `json:"ttfb_ms"`
	Retries     int32  `json:"retries"`
	ClientIP    string `json:"client_ip"`
	Error       string `json:"error"`
	// ReasoningEffort is what the caller asked the model to spend on thinking;
	// empty when the request said nothing about it.
	ReasoningEffort string `json:"reasoning_effort"`
	// ClientType is the tool that made the call, guessed from its headers.
	ClientType string `json:"client_type"`
}

// Failed reports a call that failed: an error status, or an error inside a 2xx
// body. One its caller or an operator ended is not, whatever it was logged
// with. store's failedSQL is the same test, for the rows in the database.
func (l *RequestLog) Failed() bool {
	return !l.Cancelled && (l.StatusCode >= 400 || l.Error != "")
}

// RequestLogDetail is the full request and response for one relayed call,
// held only for the most recent N calls.
//
// Separate from RequestLog because the bodies run to megabytes: the metadata is
// listed and aggregated constantly, the bodies are read one at a time.
type RequestLogDetail struct {
	LogID             int64               `json:"log_id"`
	CreatedAt         time.Time           `json:"created_at"`
	RequestHeaders    map[string][]string `json:"request_headers,omitempty"`
	RequestBody       string              `json:"request_body,omitempty"`
	RequestTruncated  bool                `json:"request_truncated"`
	ResponseHeaders   map[string][]string `json:"response_headers,omitempty"`
	ResponseBody      string              `json:"response_body,omitempty"`
	ResponseTruncated bool                `json:"response_truncated"`
}

// Invite code statuses, mirroring redemptions.
const (
	InviteUnused   = 1
	InviteUsed     = 2
	InviteDisabled = 3
)

// InviteCode buys exactly one account. It is spent in the same transaction
// that creates the user, so a failed signup leaves it untouched.
type InviteCode struct {
	ID         int64      `json:"id"`
	Code       string     `json:"code"`
	Name       string     `json:"name"`
	Status     int16      `json:"status"`
	UsedBy     *int64     `json:"used_by"`
	UsedByName string     `json:"used_by_name"`
	UsedAt     *time.Time `json:"used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// Redemption statuses.
const (
	RedemptionUnused   = 1
	RedemptionUsed     = 2
	RedemptionDisabled = 3
)

// Redemption is prepaid credit: an administrator generates it, a user
// exchanges it for balance exactly once.
type Redemption struct {
	ID   int64  `json:"id"`
	Code string `json:"code"`
	Name string `json:"name"`
	// Group ties a campaign together: a user may claim only one code from it.
	// Empty means the code carries no such restriction. Unrelated to the user
	// and channel groups used for routing.
	Group      string     `json:"group"`
	Quota      int64      `json:"quota"` // micro-USD
	Status     int16      `json:"status"`
	UsedBy     *int64     `json:"used_by"`
	UsedByName string     `json:"used_by_name"`
	UsedAt     *time.Time `json:"used_at"`
	ExpiresAt  *time.Time `json:"expires_at"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

// Usage is the normalised token accounting extracted from an upstream response.
type Usage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	// CachedTokens is the cheap half (cache reads), CacheCreationTokens the
	// expensive half (cache writes). Both are part of PromptTokens.
	CachedTokens        int `json:"cached_tokens"`
	CacheCreationTokens int `json:"cache_creation_tokens"`
	TotalTokens         int `json:"total_tokens"`
}

func (u Usage) IsZero() bool {
	return u.PromptTokens == 0 && u.CompletionTokens == 0 && u.TotalTokens == 0
}
