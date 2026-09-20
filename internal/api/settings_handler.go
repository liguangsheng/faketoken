package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
	"time"
)

// Console preferences live in the options table alongside the billing policy,
// so they survive a restart and apply to every browser rather than to whoever
// happened to set them.
const (
	optionDefaultPageSize = "console.default_page_size"
	optionInitQuota       = "console.init_quota"
	optionLogBodyLimit    = "console.log_body_limit"
	optionAllowRegister   = "console.allow_register"
	optionImportPriority  = "console.import_priority"
	optionImportWeight    = "console.import_weight"
	optionLogDetailKeep   = "console.log_detail_keep"
	optionRequireInvite   = "console.require_invite_code"
	optionBlockedStatus   = "console.blocked_status"
	// optionBlockRules holds the whole set of block groups as JSON. One row
	// rather than a table: it is read once at startup, written whole by the
	// settings form, and never queried by anything but this handler.
	optionBlockRules   = "console.block_rules"
	optionMaxRetries   = "relay.max_retries"
	optionRetryBackoff = "relay.retry_backoff_ms"
)

// maxBlockRulesJSON bounds the stored document. The per-group limits already
// bound what can match, but nothing else stops a large blob from being written
// into the options row.
const maxBlockRulesJSON = 256 << 10

const (
	defaultPageSizeFallback = 20
	// The list endpoints clamp page_size at 200 (see pagination), so a larger
	// default would silently not be honoured.
	maxDefaultPageSize = 200
	minDefaultPageSize = 5

	// A million-token context runs to several megabytes of JSON, so the cap
	// has to be in that range for a log to be worth reading at all.
	maxLogBodyLimit = 32 << 20
	minLogBodyLimit = 64 << 10

	// Imported channels land above hand-made ones by default, and carry enough
	// weight to be split finely against each other. Both are only a starting
	// point in the form — the operator still sees and can change them before
	// anything is saved.
	importPriorityFallback = 999
	importWeightFallback   = 100

	// Wide enough not to get in the way, bounded so the value still fits the
	// int32 columns these end up in.
	maxImportPriority = 1_000_000
	minImportPriority = -1_000_000
	maxImportWeight   = 1_000_000
	// Selection treats weight as a share of the draw, so zero would make a
	// channel unreachable. channelInput.toModel clamps to 1 for the same reason.
	minImportWeight = 1

	// Each retained call costs up to two bodies at the capture limit above, so
	// the ceiling here is a storage decision more than a diagnostic one:
	// 20 000 calls at the 32 MiB maximum would be far past any disk.
	maxLogDetailKeep = 20_000
	// Zero is meaningful: it stops recording bodies and clears what is stored.
	minLogDetailKeep = 0

	// Retry budget bounds: at least one attempt, at most a generous ceiling
	// so an operator cannot accidentally disable relaying entirely.
	maxMaxRetries = 20
	minMaxRetries = 1

	// Retry backoff bounds, expressed in milliseconds. A few seconds between
	// retries is as long as a caller will reasonably wait; zero means no pause.
	maxRetryBackoffMS = 10_000
	minRetryBackoffMS = 0
)

// consoleSettings is what the console needs before it can render a table, plus
// the policy knobs an administrator changes without a restart.
type consoleSettings struct {
	DefaultPageSize int `json:"default_page_size"`
	// InitQuotaUSD is what a self-registered account starts with. Dollars
	// rather than micro-USD: this one is typed by a human.
	InitQuotaUSD float64 `json:"init_quota_usd"`
	// LogBodyLimit caps how much of a request or response is kept, in bytes.
	LogBodyLimit int `json:"log_body_limit"`
	// AllowRegister opens or closes self-registration. Closing it here beats
	// the ALLOW_REGISTER environment variable, so a deployment can be shut to
	// new accounts without a restart.
	AllowRegister bool `json:"allow_register"`
	// ImportPriority and ImportWeight seed the channel form when a quick
	// import produces a new channel. They are defaults, not policy: nothing is
	// written until the operator saves the form.
	ImportPriority int `json:"import_priority"`
	ImportWeight   int `json:"import_weight"`
	// LogDetailKeep is how many of the most recent calls keep their full
	// request and response for inspection. 0 turns the recording off.
	LogDetailKeep int `json:"log_detail_keep"`
	// RequireInviteCode makes self-registration need a code an administrator
	// generated. Only meaningful while AllowRegister is on.
	RequireInviteCode bool `json:"require_invite_code"`
	// BlockedStatus is the default a group inherits when it sets none of its
	// own. A 2xx is delivered as an ordinary model answer carrying the group's
	// reply; anything else is an error carrying it as the message.
	BlockedStatus int `json:"blocked_status"`
	// BlockRules are the keyword groups a request body is checked against,
	// each with its own reply pool. Never nil, so the console always gets an
	// array to render.
	BlockRules []relay.BlockRule `json:"block_rules"`
	// MaxRetries is how many channels one request may visit. Each retry targets
	// a different channel; a channel may first spend its own retry_count on
	// attempts against itself.
	MaxRetries int `json:"max_retries"`
	// RetryBackoffMS is the base delay between those channel switches, in
	// milliseconds. It scales with the attempt number and is capped at 2
	// seconds by the relay.
	RetryBackoffMS int `json:"retry_backoff_ms"`
}

func (s *Server) consoleSettings(ctx context.Context) consoleSettings {
	// Config values are the boot defaults; a stored option overrides them.
	settings := consoleSettings{
		DefaultPageSize: defaultPageSizeFallback,
		InitQuotaUSD:    billing.FormatUSD(s.cfg.InitQuota),
		LogBodyLimit:    relay.DefaultCaptureLimit,
		AllowRegister:   s.cfg.AllowRegister,
		ImportPriority:  importPriorityFallback,
		ImportWeight:    importWeightFallback,
		LogDetailKeep:   store.DefaultLogDetailKeep,
		BlockedStatus:   relay.DefaultBlockedStatus,
		BlockRules:      []relay.BlockRule{},
		MaxRetries:      s.cfg.MaxRetries,
		RetryBackoffMS:  int(s.cfg.RetryBackoff / time.Millisecond),
	}

	options, err := s.store.AllOptions(ctx)
	if err != nil {
		// A console that cannot read its preferences still has to load.
		slog.Error("read console settings", "error", err)
		return settings
	}

	if value, err := strconv.Atoi(options[optionDefaultPageSize]); err == nil && validPageSize(value) {
		settings.DefaultPageSize = value
	}
	if value, err := strconv.ParseInt(options[optionInitQuota], 10, 64); err == nil && value >= 0 {
		settings.InitQuotaUSD = billing.FormatUSD(value)
	}
	if value, err := strconv.Atoi(options[optionLogBodyLimit]); err == nil && validLogBodyLimit(value) {
		settings.LogBodyLimit = value
	}
	if value, err := strconv.ParseBool(options[optionAllowRegister]); err == nil {
		settings.AllowRegister = value
	}
	if value, err := strconv.Atoi(options[optionImportPriority]); err == nil && validImportPriority(value) {
		settings.ImportPriority = value
	}
	if value, err := strconv.Atoi(options[optionImportWeight]); err == nil && validImportWeight(value) {
		settings.ImportWeight = value
	}
	if value, err := strconv.Atoi(options[optionLogDetailKeep]); err == nil && validLogDetailKeep(value) {
		settings.LogDetailKeep = value
	}
	if raw := options[optionBlockRules]; strings.TrimSpace(raw) != "" {
		var rules []relay.BlockRule
		if err := json.Unmarshal([]byte(raw), &rules); err != nil {
			// A corrupt row must not take the whole settings page down with it;
			// the operator sees an empty list and can save a new one over it.
			slog.Error("read block rules", "error", err)
		} else {
			settings.BlockRules = relay.NormalizeBlockRules(rules)
		}
	}
	if value, err := strconv.ParseBool(options[optionRequireInvite]); err == nil {
		settings.RequireInviteCode = value
	}
	if value, err := strconv.Atoi(options[optionBlockedStatus]); err == nil &&
		relay.ValidBlockedStatus(value) {
		settings.BlockedStatus = value
	}
	if value, err := strconv.Atoi(options[optionMaxRetries]); err == nil && validMaxRetries(value) {
		settings.MaxRetries = value
	}
	if value, err := strconv.Atoi(options[optionRetryBackoff]); err == nil && validRetryBackoffMS(value) {
		settings.RetryBackoffMS = value
	}
	return settings
}

// allowRegister answers whether self-registration is open. Read per request so
// closing it takes effect immediately, including for the anonymous status
// endpoint the login page uses to decide whether to offer the register tab.
func (s *Server) allowRegister(ctx context.Context) bool {
	raw, err := s.store.GetOption(ctx, optionAllowRegister)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			slog.Error("read registration setting", "error", err)
		}
		return s.cfg.AllowRegister
	}
	if value, err := strconv.ParseBool(raw); err == nil {
		return value
	}
	return s.cfg.AllowRegister
}

// requireInviteCode answers whether a visitor must present an invitation.
// Read per request for the same reason allowRegister is: turning it on has to
// take effect immediately, including for the anonymous status endpoint the
// login page uses to decide whether to show the field.
func (s *Server) requireInviteCode(ctx context.Context) bool {
	raw, err := s.store.GetOption(ctx, optionRequireInvite)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			slog.Error("read invite requirement", "error", err)
		}
		return false
	}
	value, err := strconv.ParseBool(raw)
	return err == nil && value
}

// countKeywords totals the keywords across groups, for the startup and save
// log lines.
func countKeywords(rules []relay.BlockRule) int {
	total := 0
	for _, rule := range rules {
		total += len(rule.Keywords)
	}
	return total
}

func validPageSize(value int) bool {
	return value >= minDefaultPageSize && value <= maxDefaultPageSize
}

func validLogBodyLimit(value int) bool {
	return value >= minLogBodyLimit && value <= maxLogBodyLimit
}

func validImportPriority(value int) bool {
	return value >= minImportPriority && value <= maxImportPriority
}

func validImportWeight(value int) bool {
	return value >= minImportWeight && value <= maxImportWeight
}

func validLogDetailKeep(value int) bool {
	return value >= minLogDetailKeep && value <= maxLogDetailKeep
}

func validMaxRetries(value int) bool {
	return value >= minMaxRetries && value <= maxMaxRetries
}

func validRetryBackoffMS(value int) bool {
	return value >= minRetryBackoffMS && value <= maxRetryBackoffMS
}

// initQuota resolves the balance a new account starts with, preferring the
// stored option over the boot-time environment variable.
func (s *Server) initQuota(ctx context.Context) int64 {
	raw, err := s.store.GetOption(ctx, optionInitQuota)
	if err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			slog.Error("read init quota", "error", err)
		}
		return s.cfg.InitQuota
	}
	if value, err := strconv.ParseInt(raw, 10, 64); err == nil && value >= 0 {
		return value
	}
	return s.cfg.InitQuota
}

// LoadRuntimeOptions applies the stored settings that live in memory rather
// than being read per request. Called once at startup.
func (s *Server) LoadRuntimeOptions(ctx context.Context) {
	settings := s.consoleSettings(ctx)
	s.applyRuntimeOptions(settings)
	slog.Info("runtime options loaded", settings.runtimeAttrs()...)
}

// applyRuntimeOptions pushes the settings the relay and the store consult on
// every request into memory. One place, so a knob added here reaches both the
// boot path and the save path.
func (s *Server) applyRuntimeOptions(settings consoleSettings) {
	s.relay.SetCaptureLimit(settings.LogBodyLimit)
	s.store.SetLogDetailKeep(settings.LogDetailKeep)
	s.relay.SetBlockPolicy(settings.BlockRules, settings.BlockedStatus)
	s.relay.SetRetryConfig(settings.MaxRetries, time.Duration(settings.RetryBackoffMS)*time.Millisecond)
}

// runtimeAttrs is the log line for the in-memory knobs.
func (c consoleSettings) runtimeAttrs() []any {
	return []any{
		"log_body_limit", c.LogBodyLimit,
		"log_detail_keep", c.LogDetailKeep,
		"block_rules", len(c.BlockRules),
		"blocked_keywords", countKeywords(c.BlockRules),
		"max_retries", c.MaxRetries,
		"retry_backoff_ms", c.RetryBackoffMS,
	}
}

// options is the stored form of the settings, one row per knob.
func (c consoleSettings) options(encodedRules []byte) map[string]string {
	return map[string]string{
		optionDefaultPageSize: strconv.Itoa(c.DefaultPageSize),
		optionInitQuota:       strconv.FormatInt(billing.ParseUSD(c.InitQuotaUSD), 10),
		optionLogBodyLimit:    strconv.Itoa(c.LogBodyLimit),
		optionAllowRegister:   strconv.FormatBool(c.AllowRegister),
		optionImportPriority:  strconv.Itoa(c.ImportPriority),
		optionImportWeight:    strconv.Itoa(c.ImportWeight),
		optionLogDetailKeep:   strconv.Itoa(c.LogDetailKeep),
		optionRequireInvite:   strconv.FormatBool(c.RequireInviteCode),
		optionBlockedStatus:   strconv.Itoa(c.BlockedStatus),
		optionBlockRules:      string(encodedRules),
		optionMaxRetries:      strconv.Itoa(c.MaxRetries),
		optionRetryBackoff:    strconv.Itoa(c.RetryBackoffMS),
	}
}

// handleGetSettings is readable by any signed-in user: a regular account still
// renders paginated tables and needs the same default.
//
// The block groups are the exception. They are the operator's policy, and a
// caller holding the keyword list would not need to probe for it at all — the
// same reason a blocked request is answered rather than refused. They travel
// only to an administrator, who is the only one who can edit them anyway.
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	settings := s.consoleSettings(r.Context())
	if u := userFrom(r.Context()); u == nil || !u.IsAdmin() {
		settings.BlockRules = []relay.BlockRule{}
	}
	ok(w, settings)
}

func (s *Server) handleUpdateSettings(w http.ResponseWriter, r *http.Request) {
	var in consoleSettings
	if !decode(w, r, &in) {
		return
	}
	if !validPageSize(in.DefaultPageSize) {
		fail(w, http.StatusBadRequest, "default page size must be between 5 and 200")
		return
	}
	if in.InitQuotaUSD < 0 {
		fail(w, http.StatusBadRequest, "the initial quota cannot be negative")
		return
	}
	if !validLogBodyLimit(in.LogBodyLimit) {
		fail(w, http.StatusBadRequest, "the log body limit must be between 64 KiB and 32 MiB")
		return
	}
	if !validImportPriority(in.ImportPriority) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"导入默认优先级需在 %d 和 %d 之间", minImportPriority, maxImportPriority))
		return
	}
	if !validImportWeight(in.ImportWeight) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"导入默认权重需在 %d 和 %d 之间", minImportWeight, maxImportWeight))
		return
	}
	if !relay.ValidBlockedStatus(in.BlockedStatus) {
		fail(w, http.StatusBadRequest, "命中后的状态码需在 200 和 599 之间")
		return
	}
	if len(in.BlockRules) > relay.MaxBlockRules {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"屏蔽规则组最多 %d 个", relay.MaxBlockRules))
		return
	}
	// Refused rather than truncated: an operator who pastes an oversized reply
	// should be told, not have it silently shortened or dropped at save time.
	for _, rule := range in.BlockRules {
		for _, reply := range rule.Replies {
			if len(reply) > relay.MaxBlockedReplyLength {
				fail(w, http.StatusBadRequest, fmt.Sprintf(
					"单条回复内容不能超过 %d 字节", relay.MaxBlockedReplyLength))
				return
			}
		}
		if rule.Status != 0 && !relay.ValidBlockedStatus(rule.Status) {
			fail(w, http.StatusBadRequest, "规则组的状态码需为 0（继承全局）或 200 到 599 之间")
			return
		}
	}

	// Normalised before it is stored, so what the console reads back is what
	// the relay is actually matching on.
	rules := relay.NormalizeBlockRules(in.BlockRules)
	encodedRules, err := json.Marshal(rules)
	if err != nil {
		failErr(w, err)
		return
	}
	if len(encodedRules) > maxBlockRulesJSON {
		fail(w, http.StatusBadRequest, "屏蔽规则配置过大")
		return
	}
	if !validLogDetailKeep(in.LogDetailKeep) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"完整日志保留条数需在 %d 和 %d 之间", minLogDetailKeep, maxLogDetailKeep))
		return
	}
	if !validMaxRetries(in.MaxRetries) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"重试次数需在 %d 和 %d 之间", minMaxRetries, maxMaxRetries))
		return
	}
	if !validRetryBackoffMS(in.RetryBackoffMS) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"重试间隔需在 %d 和 %d 毫秒之间", minRetryBackoffMS, maxRetryBackoffMS))
		return
	}

	// The normalised rules are what gets stored and applied, so the relay
	// matches on exactly what the console reads back.
	in.BlockRules = rules
	if err := s.store.SetOptions(r.Context(), in.options(encodedRules)); err != nil {
		failErr(w, err)
		return
	}
	// Only after the write landed: memory must not run ahead of a store that
	// refused the change.
	s.applyRuntimeOptions(in)

	slog.Info("console settings updated", append(in.runtimeAttrs(),
		"default_page_size", in.DefaultPageSize,
		"init_quota_usd", in.InitQuotaUSD,
		"allow_register", in.AllowRegister,
		"import_priority", in.ImportPriority,
		"import_weight", in.ImportWeight,
		"require_invite_code", in.RequireInviteCode,
		"blocked_status", in.BlockedStatus)...)
	ok(w, s.consoleSettings(r.Context()))
}
