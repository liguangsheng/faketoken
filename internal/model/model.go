// Package model holds the domain types shared by the store, API and relay layers.
package model

import "time"

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

// SupportsProtocol reports whether the channel advertises the protocol. An
// empty slice is treated as "every protocol" so a channel created before the
// column existed keeps routing as it did before.
func (c *Channel) SupportsProtocol(protocol string) bool {
	if protocol == "" || len(c.SupportedProtocols) == 0 {
		return true
	}
	for _, p := range c.SupportedProtocols {
		if p == protocol {
			return true
		}
	}
	return false
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
	RPMLimit       int32      `json:"rpm_limit"`
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
	SupportedProtocols []string  `json:"supported_protocols"`
	Note               string    `json:"note"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`

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
	ID               int64     `json:"id"`
	CreatedAt        time.Time `json:"created_at"`
	UserID           int64     `json:"user_id"`
	Username         string    `json:"username"`
	TokenID          int64     `json:"token_id"`
	TokenName        string    `json:"token_name"`
	ChannelID        int64     `json:"channel_id"`
	ChannelName      string    `json:"channel_name"`
	Model            string    `json:"model"`
	UpstreamModel    string    `json:"upstream_model"`
	Endpoint         string    `json:"endpoint"`
	Method           string    `json:"method"`
	StatusCode       int32     `json:"status_code"`
	Stream           bool      `json:"stream"`
	PromptTokens     int32     `json:"prompt_tokens"`
	CompletionTokens int32     `json:"completion_tokens"`
	// CachedTokens are prompt tokens served from cache; CacheCreationTokens
	// are the ones written into it. Both are already counted in PromptTokens.
	CachedTokens        int32  `json:"cached_tokens"`
	CacheCreationTokens int32  `json:"cache_creation_tokens"`
	TotalTokens         int32  `json:"total_tokens"`
	Cost                int64  `json:"cost"`
	DurationMS          int32  `json:"duration_ms"`
	TTFBMS              int32  `json:"ttfb_ms"`
	Retries             int32  `json:"retries"`
	ClientIP            string `json:"client_ip"`
	Error               string `json:"error"`
	// ReasoningEffort is what the caller asked the model to spend on thinking;
	// empty when the request said nothing about it.
	ReasoningEffort string `json:"reasoning_effort"`
	// ClientType is the tool that made the call, guessed from its headers.
	ClientType string `json:"client_type"`
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
