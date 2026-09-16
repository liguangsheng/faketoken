package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/keepalive"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
	"github.com/faketoken/faketoken/internal/relay"
	"github.com/faketoken/faketoken/internal/store"
)

type channelInput struct {
	Name string `json:"name"`
	// Type is accepted as an ignored compatibility field for older API
	// clients. It is neither stored nor returned.
	Type          string            `json:"type,omitempty"`
	BaseURL       string            `json:"base_url"`
	AuthStyle     string            `json:"auth_style"`
	APIKey        string            `json:"api_key"`
	Status        int16             `json:"status"`
	Priority      int32             `json:"priority"`
	Weight        int32             `json:"weight"`
	Groups        []string          `json:"groups"`
	Models        []string          `json:"models"`
	ModelPrefixes []string          `json:"model_prefixes"`
	ModelMapping  map[string]string `json:"model_mapping"`
	Headers       map[string]string `json:"headers"`
	TimeoutSecs   int32             `json:"timeout_secs"`
	ProxyURL      string            `json:"proxy_url"`
	PriceRatio    float64           `json:"price_ratio"`
	RPMLimit      int32             `json:"rpm_limit"`
	TestModel     string            `json:"test_model"`
	// SupportedProtocols narrows routing to the dialects the upstream answers.
	// Empty means every dialect, so channels created before the field existed
	// keep routing as they did before.
	SupportedProtocols     []string          `json:"supported_protocols"`
	ConvertMessagesToChat  bool              `json:"convert_messages_to_chat"`
	ConvertResponsesToChat bool              `json:"convert_responses_to_chat"`
	ReasoningEffortMapping map[string]string `json:"reasoning_effort_mapping"`
	AllowAttachments       *bool             `json:"allow_attachments"`
	LockUserAgent          bool              `json:"lock_user_agent"`
	LockedUserAgents       map[string]string `json:"locked_user_agents"`
	Note                   string            `json:"note"`
	// Keepalive configuration. The window's own state (open, progress, when it
	// last opened) is owned by the scheduler and the relay bookkeeping, and is
	// never accepted from a request: saving the form must not reset a counter.
	KeepaliveEnabled bool   `json:"keepalive_enabled"`
	KeepaliveAt      string `json:"keepalive_at"`
	KeepaliveTarget  int32  `json:"keepalive_target"`
}

func (in channelInput) toModel(id int64) *model.Channel {
	ch := &model.Channel{
		ID:                     id,
		Name:                   strings.TrimSpace(in.Name),
		BaseURL:                strings.TrimSpace(in.BaseURL),
		AuthStyle:              defaultString(in.AuthStyle, model.AuthStyleAuto),
		APIKey:                 strings.TrimSpace(in.APIKey),
		Status:                 normaliseChannelStatus(in.Status),
		Priority:               in.Priority,
		Weight:                 max(in.Weight, 1),
		Groups:                 cleanList(in.Groups, "default"),
		Models:                 cleanList(in.Models),
		ModelPrefixes:          cleanList(in.ModelPrefixes),
		ModelMapping:           in.ModelMapping,
		Headers:                in.Headers,
		TimeoutSecs:            in.TimeoutSecs,
		ProxyURL:               strings.TrimSpace(in.ProxyURL),
		PriceRatio:             in.PriceRatio,
		RPMLimit:               in.RPMLimit,
		TestModel:              strings.TrimSpace(in.TestModel),
		SupportedProtocols:     in.SupportedProtocols,
		ConvertMessagesToChat:  in.ConvertMessagesToChat,
		ConvertResponsesToChat: in.ConvertResponsesToChat,
		ReasoningEffortMapping: cleanEffortMapping(in.ReasoningEffortMapping),
		AllowAttachments:       in.AllowAttachments == nil || *in.AllowAttachments,
		LockUserAgent:          in.LockUserAgent,
		LockedUserAgents:       cleanUserAgentLocks(in.LockedUserAgents),
		Note:                   in.Note,
		KeepaliveEnabled:       in.KeepaliveEnabled,
		KeepaliveAt:            strings.TrimSpace(in.KeepaliveAt),
		KeepaliveTarget:        in.KeepaliveTarget,
	}
	if ch.PriceRatio <= 0 {
		ch.PriceRatio = 1
	}
	if ch.ModelMapping == nil {
		ch.ModelMapping = map[string]string{}
	}
	if ch.Headers == nil {
		ch.Headers = map[string]string{}
	}
	return ch
}

func cleanUserAgentLocks(in map[string]string) map[string]string {
	out := make(map[string]string, len(validUserAgentProtocols))
	for protocol := range validUserAgentProtocols {
		if value := strings.TrimSpace(in[protocol]); value != "" {
			out[protocol] = value
		}
	}
	return out
}

// cleanEffortMapping folds the levels an operator typed to lowercase and drops
// the half-filled rows the console's key/value editor leaves behind. The store
// normalises again on write; doing it here as well is what makes the channel
// returned by a create or update already show what was actually stored.
func cleanEffortMapping(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for from, to := range in {
		from = strings.ToLower(strings.TrimSpace(from))
		to = strings.TrimSpace(to)
		if from == "" || to == "" {
			continue
		}
		out[from] = to
	}
	return out
}

// validEffortMapping refuses a rule that maps a level onto whitespace or onto a
// value carrying JSON punctuation. The rename is spliced into the request body
// as a JSON string, so a stray quote or brace is either meaningless to the
// upstream or a rejected request, and either way the operator meant something
// else.
func validEffortMapping(in channelInput) (string, bool) {
	for from, to := range in.ReasoningEffortMapping {
		from = strings.TrimSpace(from)
		to = strings.TrimSpace(to)
		// One side filled and the other empty is a row still being typed; it is
		// dropped rather than refused, so saving the form is never blocked by a
		// leftover blank line.
		if from == "" || to == "" {
			continue
		}
		if strings.ContainsAny(to, "\"'{}[]\\\n\r\t") || strings.ContainsAny(from, "\"'{}[]\\\n\r\t") {
			return "思考强度映射只能填写等级名称，不能包含引号、括号或换行", false
		}
	}
	return "", true
}

var validUserAgentProtocols = map[string]bool{
	model.ProtocolChatCompletions: true,
	model.ProtocolResponses:       true,
	model.ProtocolMessages:        true,
}

func (s *Server) handleClearChannelUserAgent(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	protocol := strings.TrimSpace(r.URL.Query().Get("protocol"))
	if !validUserAgentProtocols[protocol] {
		fail(w, http.StatusBadRequest, "protocol must be chat_completions, responses, or messages")
		return
	}
	updated, err := s.store.ClearChannelUserAgent(r.Context(), id, protocol)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(updated))
}

// mask hides the upstream credential; the console never needs the real value.
func mask(ch *model.Channel) *model.Channel {
	clone := *ch
	if clone.APIKey != "" {
		clone.APIKey = auth.MaskAPIKey(clone.APIKey)
	}
	return &clone
}

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	offset, limit := pagination(r)
	channels, total, err := s.store.ListChannels(r.Context(), store.ChannelFilter{
		Keyword: r.URL.Query().Get("keyword"),
		Status:  queryInt(r, "status", 0),
		Group:   r.URL.Query().Get("group"),
		Model:   r.URL.Query().Get("model"),
		// Absent means every channel, so an existing API caller keeps seeing
		// what it did before the archive existed. The console asks for one
		// side explicitly.
		Archived: queryBoolPtr(r, "archived"),
		Offset:   offset,
		Limit:    limit,
	})
	if err != nil {
		failErr(w, err)
		return
	}
	masked := make([]*model.Channel, len(channels))
	for i, ch := range channels {
		masked[i] = mask(ch)
	}
	ok(w, page[*model.Channel]{Data: masked, Total: total})
}

func (s *Server) handleGetChannel(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(ch))
}

// handleChannelCredential hands back the upstream connection in the clear, so
// an operator can move a channel into another tool without digging the key out
// of the database.
//
// Its own endpoint rather than a field on the listing, for the same reason the
// token reveal is: the list is polled constantly, and putting plaintext
// credentials in it would spray them through logs, proxy caches and browser
// history. Here the credential travels only when somebody asks for one.
func (s *Server) handleChannelCredential(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}

	slog.Info("channel credential revealed",
		"channel", ch.ID, "name", ch.Name, "by", userFrom(r.Context()).Username)
	ok(w, map[string]string{
		"base_url": ch.BaseURL,
		"api_key":  ch.APIKey,
	})
}

// validKeepalive checks the schedule an operator typed. An unparseable time or
// a zero target would leave a channel that says it is kept alive and never is,
// so it is refused at write time rather than ignored by the scheduler.
func validKeepalive(in channelInput) (string, bool) {
	if !in.KeepaliveEnabled {
		return "", true
	}
	if _, _, ok := keepalive.ParseAt(strings.TrimSpace(in.KeepaliveAt)); !ok {
		return "keepalive needs a daily time as HH:MM, for example 03:00", false
	}
	if in.KeepaliveTarget < 1 {
		return "keepalive needs a target of at least one successful request", false
	}
	return "", true
}

func validProtocolConversion(in channelInput) (string, bool) {
	if (!in.ConvertMessagesToChat && !in.ConvertResponsesToChat) || len(in.SupportedProtocols) == 0 {
		return "", true
	}
	for _, protocol := range in.SupportedProtocols {
		if strings.TrimSpace(protocol) == model.ProtocolChatCompletions {
			return "", true
		}
	}
	return "protocol conversion requires chat_completions in supported_protocols", false
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var in channelInput
	if !decode(w, r, &in) {
		return
	}
	if in.Name == "" {
		fail(w, http.StatusBadRequest, "the channel name is required")
		return
	}
	if strings.TrimSpace(in.BaseURL) == "" {
		fail(w, http.StatusBadRequest, "the channel base URL is required")
		return
	}
	if !validAuthStyle(in.AuthStyle) {
		fail(w, http.StatusBadRequest, "unsupported authentication style: "+in.AuthStyle)
		return
	}
	if message, ok := validKeepalive(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}
	if message, ok := validProtocolConversion(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}
	if message, ok := validEffortMapping(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}

	created, err := s.store.CreateChannel(r.Context(), in.toModel(0))
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, http.StatusCreated, mask(created))
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in channelInput
	if !decode(w, r, &in) {
		return
	}
	// The create path already refuses an empty name; without the same check
	// here an update could silently blank it out.
	if strings.TrimSpace(in.Name) == "" {
		fail(w, http.StatusBadRequest, "the channel name is required")
		return
	}
	if strings.TrimSpace(in.BaseURL) == "" {
		fail(w, http.StatusBadRequest, "the channel base URL is required")
		return
	}
	if !validAuthStyle(in.AuthStyle) {
		fail(w, http.StatusBadRequest, "unsupported authentication style: "+in.AuthStyle)
		return
	}
	if message, ok := validKeepalive(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}
	if message, ok := validProtocolConversion(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}
	if message, ok := validEffortMapping(in); !ok {
		fail(w, http.StatusBadRequest, message)
		return
	}

	updated, err := s.store.UpdateChannel(r.Context(), in.toModel(id))
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(updated))
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	if err := s.store.DeleteChannel(r.Context(), id); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "channel deleted"})
}

func (s *Server) handleChannelStatus(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in struct {
		Status int16 `json:"status"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := s.store.SetChannelStatus(r.Context(), id, normaliseChannelStatus(in.Status), ""); err != nil {
		failErr(w, err)
		return
	}
	ch, err := s.store.GetChannel(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(ch))
}

// handleChannelArchive retires a channel or brings it back. Archiving disables
// it in the same transaction, which the store owns: a channel that kept serving
// traffic from behind the console's collapsed section would be invisible
// exactly while it mattered.
func (s *Server) handleChannelArchive(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in struct {
		Archived bool `json:"archived"`
	}
	if !decode(w, r, &in) {
		return
	}

	updated, err := s.store.SetChannelArchived(r.Context(), id, in.Archived)
	if err != nil {
		failErr(w, err)
		return
	}
	slog.Info("channel archive changed", "channel", updated.ID, "name", updated.Name,
		"archived", updated.Archived, "by", userFrom(r.Context()).Username)
	ok(w, mask(updated))
}

// handleChannelRouting updates only priority and weight, which the console
// edits in place from the channel table.
//
// Its own endpoint rather than a full update, for the same reason the status
// toggle has one: the listing carries a masked credential, so a table-level
// edit has nothing to send for api_key, and the narrow write also cannot
// blank a field the operator never saw.
func (s *Server) handleChannelRouting(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in struct {
		Priority int32 `json:"priority"`
		Weight   int32 `json:"weight"`
	}
	if !decode(w, r, &in) {
		return
	}
	// Same floor as channelInput.toModel: selection treats weight as a share of
	// the draw, so zero would quietly take the channel out of rotation without
	// it ever showing as disabled.
	updated, err := s.store.SetChannelRouting(r.Context(), id, in.Priority, max(in.Weight, 1))
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(updated))
}

func (s *Server) handleTestChannel(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}
	var in struct {
		Model    string `json:"model"`
		Protocol string `json:"protocol"`
		// Prompt turns the probe into a real inference request; PromptTemplate
		// names one of the built-ins instead of repeating its text.
		Prompt         string `json:"prompt"`
		PromptTemplate string `json:"prompt_template"`
	}
	if r.ContentLength > 0 && !decode(w, r, &in) {
		return
	}
	if !relay.ValidTestProtocol(in.Protocol) {
		fail(w, http.StatusBadRequest,
			"protocol must be responses, chat_completions, or messages")
		return
	}

	prompt := strings.TrimSpace(in.Prompt)
	if prompt == "" && in.PromptTemplate != "" {
		template, found := relay.PromptTemplateByID(in.PromptTemplate)
		if !found {
			fail(w, http.StatusBadRequest, "unknown prompt template: "+in.PromptTemplate)
			return
		}
		prompt = template.Prompt
	}

	ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
	defer cancel()

	result := s.relay.TestChannelWith(ctx, ch, relay.TestOptions{
		Model: in.Model, Protocol: in.Protocol, Prompt: prompt,
	})
	// Detached from the request context: the probe already finished, and the
	// browser navigating away must not lose the record of what it cost.
	logCtx := context.WithoutCancel(ctx)
	s.store.MarkChannelTested(logCtx, ch.ID, time.Now(), result.Message)
	s.logChannelTest(logCtx, userFrom(r.Context()), ch, result)
	ok(w, result)
}

// handlePromptTemplates lists the built-in probe prompts.
func (s *Server) handlePromptTemplates(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{"data": relay.PromptTemplates()})
}

// handleFetchModels pulls the upstream catalogue. With ?apply=true the result
// also becomes the channel's served model list (and therefore its routing).
func (s *Server) handleFetchModels(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}

	models, err := s.relay.FetchModels(r.Context(), ch)
	if err != nil {
		fail(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := s.store.ReplaceChannelModels(r.Context(), ch.ID, models); err != nil {
		failErr(w, err)
		return
	}

	applied := false
	if queryBool(r, "apply") {
		if _, err := s.store.SetChannelModels(r.Context(), ch.ID, models); err != nil {
			failErr(w, err)
			return
		}
		applied = true
	}
	ok(w, map[string]any{"models": models, "count": len(models), "applied": applied})
}

func (s *Server) handleChannelModels(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	models, err := s.store.ListChannelModels(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"data": models})
}

func (s *Server) handleSetChannelModels(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in struct {
		Models []string `json:"models"`
	}
	if !decode(w, r, &in) {
		return
	}
	updated, err := s.store.SetChannelModels(r.Context(), id, cleanList(in.Models))
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, mask(updated))
}

// ChannelTestClient marks a log row as produced by the console's test button
// rather than by a client. It is a filterable value on purpose: a probe is
// real spend and belongs in the log, but it is not traffic, and reports that
// cannot tell the two apart are misleading.
const ChannelTestClient = "channel-test"

// logChannelTest records a probe in the request log, so the console's own
// calls are as visible as everything else that reaches an upstream.
//
// Deliberately not a full settle(): no quota is consumed, because a probe uses
// the channel's own upstream credential and belongs to no user's allowance,
// and the channel counters are left alone so a bulk probe does not show up as
// a spike in that channel's error rate.
func (s *Server) logChannelTest(ctx context.Context, admin *model.User,
	ch *model.Channel, result relay.TestResult) {

	if admin == nil {
		return
	}
	status := int32(result.Status)
	if status == 0 {
		// The upstream was never reached — a DNS failure, a refused
		// connection, a timeout. Recorded as a gateway error so the row is
		// found by a status filter and not just by a non-empty message.
		status = http.StatusBadGateway
	}

	entry := &model.RequestLog{
		UserID:   admin.ID,
		Username: admin.Username,
		// No key is involved; a probe authenticates with the channel's own
		// upstream credential. The name is a label, not a reference, so it
		// says what this row is.
		TokenID:       0,
		TokenName:     ChannelTestClient,
		ChannelID:     ch.ID,
		ChannelName:   ch.Name,
		Model:         result.Model,
		UpstreamModel: result.UpstreamModel,
		Endpoint:      result.Endpoint,
		Method:        http.MethodPost,
		StatusCode:    status,
		DurationMS:    int32(result.LatencyMS),
		Error:         result.Message,
		ClientType:    ChannelTestClient,

		PromptTokens:        int32(result.Usage.PromptTokens),
		CompletionTokens:    int32(result.Usage.CompletionTokens),
		CachedTokens:        int32(result.Usage.CachedTokens),
		CacheCreationTokens: int32(result.Usage.CacheCreationTokens),
		TotalTokens:         int32(result.Usage.TotalTokens),
	}

	// Priced like any other call. A probe spends real money, and a log that
	// showed it as free would understate what the console itself costs.
	if result.OK && !result.Usage.IsZero() {
		entry.Cost, _ = s.pricer.Cost(entry.Model, result.Usage, admin.Group, ch.PriceRatio)
	}

	if err := s.store.InsertLog(ctx, entry); err != nil {
		// A missing log line must not turn a successful probe into a failure.
		slog.Error("channel test log insert failed", "channel", ch.ID, "error", err)
		return
	}
	s.stream.Publish(entry)

	// The exchange itself is the most useful part of a probe: it shows what
	// was asked and exactly how the upstream answered.
	detail := result.Detail
	detail.LogID = entry.ID
	if err := s.store.InsertLogDetail(ctx, &detail); err != nil {
		slog.Error("channel test detail insert failed", "log", entry.ID, "error", err)
	}
}

// ------------------------------------------------------------ bulk actions

// idsInput is the payload every bulk action shares, whatever it acts on.
type idsInput struct {
	IDs []int64 `json:"ids"`
}

// validIDs rejects an empty or oversized selection. An unbounded list would let
// one request rewrite the whole routing table in a single transaction.
//
// subject names what is being selected so the message reads correctly wherever
// this is reused; bulk actions exist on more than one resource.
func validIDs(w http.ResponseWriter, ids []int64, subject string) ([]int64, bool) {
	seen := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	if len(out) == 0 {
		fail(w, http.StatusBadRequest, fmt.Sprintf("请至少选择一个%s", subject))
		return nil, false
	}
	if len(out) > 200 {
		fail(w, http.StatusBadRequest, fmt.Sprintf("一次最多处理 200 个%s", subject))
		return nil, false
	}
	return out, true
}

func (s *Server) handleBatchChannelStatus(w http.ResponseWriter, r *http.Request) {
	var in struct {
		idsInput
		Status int16 `json:"status"`
	}
	if !decode(w, r, &in) {
		return
	}
	ids, valid := validIDs(w, in.IDs, "渠道")
	if !valid {
		return
	}

	updated, err := s.store.SetChannelsStatus(r.Context(), ids, normaliseChannelStatus(in.Status))
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"updated": updated})
}

func (s *Server) handleBatchDeleteChannels(w http.ResponseWriter, r *http.Request) {
	var in idsInput
	if !decode(w, r, &in) {
		return
	}
	ids, valid := validIDs(w, in.IDs, "渠道")
	if !valid {
		return
	}

	deleted, err := s.store.DeleteChannels(r.Context(), ids)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"deleted": deleted})
}

// batchTestConcurrency keeps a bulk probe from opening one connection per
// channel at once; upstreams rate-limit, and the console only needs the verdict.
const batchTestConcurrency = 4

type batchTestResult struct {
	ChannelID int64  `json:"channel_id"`
	Name      string `json:"name"`
	relay.TestResult
}

func (s *Server) handleBatchTestChannels(w http.ResponseWriter, r *http.Request) {
	var in idsInput
	if !decode(w, r, &in) {
		return
	}
	ids, valid := validIDs(w, in.IDs, "渠道")
	if !valid {
		return
	}
	// Read before the goroutines start: they outlive the request, and the
	// identity has to be captured while the request context is still the one
	// that carries it.
	admin := userFrom(r.Context())

	// Detached from the request: a bulk probe of slow upstreams outlives an
	// impatient browser, and half-written test timestamps help nobody.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 3*time.Minute)
	defer cancel()

	results := make([]batchTestResult, len(ids))
	sem := make(chan struct{}, batchTestConcurrency)
	var wg sync.WaitGroup

	for i, id := range ids {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ch, err := s.store.GetChannel(ctx, id)
			if err != nil {
				results[i] = batchTestResult{ChannelID: id,
					TestResult: relay.TestResult{Message: "channel not found"}}
				return
			}
			result := s.relay.TestChannel(ctx, ch, "")
			s.store.MarkChannelTested(ctx, ch.ID, time.Now(), result.Message)
			s.logChannelTest(ctx, admin, ch, result)
			results[i] = batchTestResult{ChannelID: id, Name: ch.Name, TestResult: result}
		}(i, id)
	}
	wg.Wait()

	passed := 0
	for _, result := range results {
		if result.OK {
			passed++
		}
	}
	ok(w, map[string]any{"data": results, "total": len(results), "passed": passed})
}

func (s *Server) handleCloneChannel(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid channel id")
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if r.ContentLength > 0 && !decode(w, r, &in) {
		return
	}

	clone, err := s.store.CloneChannel(r.Context(), id, in.Name)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, http.StatusCreated, mask(clone))
}

// handleChannelBalance queries the new-api billing endpoints.
func (s *Server) handleChannelBalance(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, s.relay.FetchNewAPIBalance(r.Context(), ch))
}

// handleChannelSub2APIBalance queries sub2api's independent /usage endpoint.
func (s *Server) handleChannelSub2APIBalance(w http.ResponseWriter, r *http.Request) {
	ch, err := s.channelFromPath(r)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, s.relay.FetchSub2APIBalance(r.Context(), ch))
}

func (s *Server) handleRebuildAbilities(w http.ResponseWriter, r *http.Request) {
	if err := s.store.RebuildAllAbilities(r.Context()); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "routing table rebuilt"})
}

// ------------------------------------------------------------------ helpers

func (s *Server) channelFromPath(r *http.Request) (*model.Channel, error) {
	id, err := pathID(r, "id")
	if err != nil {
		return nil, store.ErrNotFound
	}
	return s.store.GetChannel(r.Context(), id)
}

func validAuthStyle(style string) bool {
	if style == "" {
		return true
	}
	for _, known := range provider.AuthStyles() {
		if known == style {
			return true
		}
	}
	return false
}

func normaliseChannelStatus(status int16) int16 {
	switch status {
	case model.StatusDisabled, 3:
		// Treat the retired auto-disabled value as manually disabled when an
		// older client sends it back, but never create that state again.
		return model.StatusDisabled
	default:
		return model.StatusEnabled
	}
}

func cleanList(in []string, fallback ...string) []string {
	seen := map[string]struct{}{}
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
	if len(out) == 0 && len(fallback) > 0 {
		return fallback
	}
	return out
}
