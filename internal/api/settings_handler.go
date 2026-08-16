package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
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
	optionBlockedKeywords = "console.blocked_keywords"
	optionRequireInvite   = "console.require_invite_code"
	optionBlockedStatus   = "console.blocked_status"
	optionBlockedReply    = "console.blocked_reply"
)

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
	// BlockedKeywords is one keyword per line. A request whose body contains
	// any of them is refused before it reaches an upstream.
	BlockedKeywords string `json:"blocked_keywords"`
	// RequireInviteCode makes self-registration need a code an administrator
	// generated. Only meaningful while AllowRegister is on.
	RequireInviteCode bool `json:"require_invite_code"`
	// BlockedStatus and BlockedReply decide what a caller sees when a keyword
	// matches. A 2xx is delivered as an ordinary model answer carrying the
	// text; anything else is an error carrying it as the message.
	BlockedStatus int    `json:"blocked_status"`
	BlockedReply  string `json:"blocked_reply"`
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
		BlockedReply:    relay.DefaultBlockedReply,
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
	// Stored as typed, so the console shows the operator their own text rather
	// than a normalised version of it.
	settings.BlockedKeywords = options[optionBlockedKeywords]
	if value, err := strconv.ParseBool(options[optionRequireInvite]); err == nil {
		settings.RequireInviteCode = value
	}
	if value, err := strconv.Atoi(options[optionBlockedStatus]); err == nil &&
		relay.ValidBlockedStatus(value) {
		settings.BlockedStatus = value
	}
	if value := options[optionBlockedReply]; strings.TrimSpace(value) != "" {
		settings.BlockedReply = value
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
	s.relay.SetCaptureLimit(settings.LogBodyLimit)
	s.store.SetLogDetailKeep(settings.LogDetailKeep)
	keywords := relay.ParseKeywords(settings.BlockedKeywords)
	s.relay.SetBlockPolicy(keywords, settings.BlockedStatus, settings.BlockedReply)
	slog.Info("runtime options loaded",
		"log_body_limit", settings.LogBodyLimit,
		"log_detail_keep", settings.LogDetailKeep,
		"blocked_keywords", len(keywords))
}

// handleGetSettings is readable by any signed-in user: a regular account still
// renders paginated tables and needs the same default.
func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	ok(w, s.consoleSettings(r.Context()))
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
	// The raw text is stored as typed, so it needs a bound of its own: the
	// parsed list is capped, but nothing else stops a large blob from being
	// written into the options row.
	if len(in.BlockedKeywords) > 64<<10 {
		fail(w, http.StatusBadRequest, "屏蔽关键词列表过长")
		return
	}
	if !relay.ValidBlockedStatus(in.BlockedStatus) {
		fail(w, http.StatusBadRequest, "命中后的状态码需在 200 和 599 之间")
		return
	}
	if len(in.BlockedReply) > relay.MaxBlockedReplyLength {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"命中后的回复内容不能超过 %d 字节", relay.MaxBlockedReplyLength))
		return
	}
	if !validLogDetailKeep(in.LogDetailKeep) {
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"完整日志保留条数需在 %d 和 %d 之间", minLogDetailKeep, maxLogDetailKeep))
		return
	}

	for key, value := range map[string]string{
		optionDefaultPageSize: strconv.Itoa(in.DefaultPageSize),
		optionInitQuota:       strconv.FormatInt(billing.ParseUSD(in.InitQuotaUSD), 10),
		optionLogBodyLimit:    strconv.Itoa(in.LogBodyLimit),
		optionAllowRegister:   strconv.FormatBool(in.AllowRegister),
		optionImportPriority:  strconv.Itoa(in.ImportPriority),
		optionImportWeight:    strconv.Itoa(in.ImportWeight),
		optionLogDetailKeep:   strconv.Itoa(in.LogDetailKeep),
		optionBlockedKeywords: in.BlockedKeywords,
		optionRequireInvite:   strconv.FormatBool(in.RequireInviteCode),
		optionBlockedStatus:   strconv.Itoa(in.BlockedStatus),
		optionBlockedReply:    in.BlockedReply,
	} {
		if err := s.store.SetOption(r.Context(), key, value); err != nil {
			failErr(w, err)
			return
		}
	}

	// Both of these are consulted per relayed request, so they are pushed into
	// memory rather than read back from the options table every time.
	s.relay.SetCaptureLimit(in.LogBodyLimit)
	s.store.SetLogDetailKeep(in.LogDetailKeep)
	s.relay.SetBlockPolicy(relay.ParseKeywords(in.BlockedKeywords),
		in.BlockedStatus, in.BlockedReply)

	slog.Info("console settings updated",
		"default_page_size", in.DefaultPageSize,
		"init_quota_usd", in.InitQuotaUSD,
		"log_body_limit", in.LogBodyLimit,
		"allow_register", in.AllowRegister,
		"import_priority", in.ImportPriority,
		"import_weight", in.ImportWeight,
		"log_detail_keep", in.LogDetailKeep,
		"blocked_keywords", len(relay.ParseKeywords(in.BlockedKeywords)),
		"require_invite_code", in.RequireInviteCode,
		"blocked_status", in.BlockedStatus)
	ok(w, s.consoleSettings(r.Context()))
}
