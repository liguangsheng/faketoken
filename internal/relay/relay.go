// Package relay forwards client requests to upstream providers as verbatim as
// possible: only the credentials, the destination host and (optionally) the
// model name are rewritten. Everything else — headers, query string, body,
// status code, response headers and streamed bytes — is passed straight
// through in both directions.
package relay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/config"
	"github.com/faketoken/faketoken/internal/logstream"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/provider"
	"github.com/faketoken/faketoken/internal/store"
)

// maxRequestBody bounds how much of a client request is buffered. Buffering is
// what makes transparent retries across channels possible.
const maxRequestBody = 100 << 20 // 100 MiB

type Relay struct {
	st      *store.Store
	pricer  *billing.Pricer
	cfg     *config.Config
	clients *clientPool
	breaker *breaker
	limiter *rpmLimiter
	// tokenLimiter is the same sliding window keyed by token id, enforcing
	// each key's own rpm_limit before any routing happens.
	tokenLimiter *rpmLimiter
	// stream notifies connected consoles about new log rows. Optional: the
	// relay works without one.
	stream *logstream.Broker
	// capture is the full-log body cap, updated from the console without a
	// restart and read on every relayed request.
	capture atomic.Int64
	// blocked holds the keyword list a request body is refused for. Same
	// treatment as capture: pushed from the console, read per request.
	blocked blockedStore
	// retryBudget is the max number of channels one request may visit, updated
	// from the console without a restart and read on every relayed request.
	retryBudget atomic.Int64
	// retryBackoff is the base delay before moving to another channel (as
	// nanoseconds), same treatment as retryBudget.
	retryBackoff atomic.Int64
	// liveSeq mints the key that ties a call's in-flight announcements to the
	// row that finally settles it. Process-local and restart-cheap: a console
	// drops whatever it was holding when the stream reconnects, so a key reused
	// after a restart can never land on a stale placeholder.
	liveSeq atomic.Uint64
	// cancels is how the console reaches a call that is already talking to an
	// upstream. Keyed by the same live key, so the row an operator is looking
	// at and the goroutine they abort are the same thing by construction.
	cancels *liveCancels
}

func New(st *store.Store, pricer *billing.Pricer, cfg *config.Config) *Relay {
	rl := &Relay{
		st:           st,
		pricer:       pricer,
		cfg:          cfg,
		clients:      newClientPool(),
		breaker:      newBreaker(),
		limiter:      newRPMLimiter(),
		tokenLimiter: newRPMLimiter(),
		cancels:      newLiveCancels(),
	}
	rl.capture.Store(DefaultCaptureLimit)
	rl.retryBudget.Store(int64(cfg.MaxRetries))
	rl.retryBackoff.Store(int64(cfg.RetryBackoff))
	return rl
}

// SetLogStream attaches the broker that pushes new entries to the console.
func (rl *Relay) SetLogStream(broker *logstream.Broker) { rl.stream = broker }

// publishLog notifies live consoles. Called only after the row is committed,
// so what a console shows always matches what a reload would return. The key
// names the placeholder this row replaces, and is empty for a call that was
// answered before it ever reached an upstream.
func (rl *Relay) publishLog(key string, entry *model.RequestLog) {
	if rl.stream != nil {
		rl.stream.Publish(key, entry)
	}
}

// beginLive mints a correlation key and announces the call as running.
//
// Only calls that are about to reach an upstream are announced. Everything a
// request can be rejected for before that — an unknown model, a closed group,
// a missing price — is decided in microseconds, and a row that appears and
// vanishes inside one frame is noise rather than news.
func (rl *Relay) beginLive(entry *model.RequestLog) string {
	if rl.stream == nil {
		return ""
	}
	key := strconv.FormatUint(rl.liveSeq.Add(1), 36)
	rl.stream.Announce(key, entry)
	return key
}

// routeLive re-announces a running call now that a channel has been picked for
// this attempt.
//
// The entry itself is deliberately not touched: attempt() is what settles which
// upstream model and thinking level really go out, and writing a channel onto
// the row before the attempt happens would leave that channel standing on the
// log line even if this attempt fails and another channel answers. So the
// channel is applied to the copy the broker keeps.
func (rl *Relay) routeLive(key string, entry *model.RequestLog, ch *model.Channel) {
	if rl.stream == nil || key == "" {
		return
	}
	routed := *entry
	routed.ChannelID = ch.ID
	routed.ChannelName = ch.Name
	routed.UpstreamModel = ch.UpstreamModel(entry.Model)
	rl.stream.Announce(key, &routed)
}

// endLive drops the call from the in-flight set.
//
// Deferred around the dispatch, so no exit path can leave a row running
// forever — including the one that writes no log at all, when the caller hangs
// up while the relay is backing off between retries. Publishing the settled row
// retires the same key, so the ordinary path simply finds nothing left to drop.
func (rl *Relay) endLive(key string) {
	if rl.stream != nil {
		rl.stream.Forget(key)
	}
}

// CancelLive aborts a call that is still running and reports whether there was
// one to abort. A false return is a race, not a fault: the call settled between
// the console drawing the button and the press arriving.
func (rl *Relay) CancelLive(key string) bool { return rl.cancels.cancel(key) }

// Register mounts the relay on the OpenAI, Anthropic and Gemini path prefixes.
func (rl *Relay) Register(mux *http.ServeMux) {
	mux.HandleFunc("/v1/models", rl.handleModels)
	mux.HandleFunc("/v1/models/", rl.handleModels)
	// The billing pair another gateway reads when it adds this one as a
	// channel. Same shape this relay probes upstreams with.
	mux.HandleFunc("/dashboard/billing/subscription", rl.handleBillingSubscription)
	mux.HandleFunc("/dashboard/billing/usage", rl.handleBillingUsage)
	mux.Handle("/v1/", http.HandlerFunc(rl.ServeHTTP))
	mux.Handle("/v1beta/", http.HandlerFunc(rl.ServeHTTP))
	mux.Handle("/v1alpha/", http.HandlerFunc(rl.ServeHTTP))
}

// ------------------------------------------------------------------- errors

type apiError struct {
	Message string `json:"message"`
	Type    string `json:"type"`
	Code    string `json:"code,omitempty"`
	Param   string `json:"param,omitempty"`
}

func writeError(w http.ResponseWriter, status int, errType, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]apiError{
		"error": {Message: message, Type: errType, Code: code},
	})
}

// ------------------------------------------------------------- authentication

type principal struct {
	user  *model.User
	token *model.Token
}

// group decides both which channels this request may reach and the price
// multiplier applied to it. A key may name its own group; falling back to the
// account's is what every key did before per-key groups existed.
func (p *principal) group() string {
	if p.token != nil && p.token.Group != "" {
		return p.token.Group
	}
	return p.user.Group
}

func extractKey(r *http.Request) string {
	if v := r.Header.Get("Authorization"); v != "" {
		if after, ok := strings.CutPrefix(v, "Bearer "); ok {
			return strings.TrimSpace(after)
		}
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Api-Key"); v != "" {
		return strings.TrimSpace(v)
	}
	if v := r.Header.Get("X-Goog-Api-Key"); v != "" {
		return strings.TrimSpace(v)
	}
	return strings.TrimSpace(r.URL.Query().Get("key"))
}

func (rl *Relay) authenticate(ctx context.Context, r *http.Request) (*principal, int, error) {
	raw := extractKey(r)
	if raw == "" {
		return nil, http.StatusUnauthorized, errors.New("missing API key: send it as 'Authorization: Bearer sk-...'")
	}

	token, err := rl.st.GetTokenByHash(ctx, auth.HashAPIKey(raw))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return nil, http.StatusUnauthorized, errors.New("invalid API key")
		}
		return nil, http.StatusInternalServerError, err
	}
	if token.Status != model.StatusEnabled {
		return nil, http.StatusForbidden, errors.New("this API key is disabled")
	}
	if token.ExpiresAt != nil && time.Now().After(*token.ExpiresAt) {
		return nil, http.StatusForbidden, errors.New("this API key has expired")
	}
	if !token.UnlimitedQuota && token.Quota <= 0 {
		return nil, http.StatusPaymentRequired, errors.New("this API key has exhausted its quota")
	}

	user, err := rl.st.GetUser(ctx, token.UserID)
	if err != nil {
		return nil, http.StatusUnauthorized, errors.New("the owner of this API key no longer exists")
	}
	if user.Status != model.StatusEnabled {
		return nil, http.StatusForbidden, errors.New("this account is disabled")
	}
	if user.Quota <= 0 {
		return nil, http.StatusPaymentRequired, errors.New("insufficient balance")
	}
	return &principal{user: user, token: token}, 0, nil
}

// --------------------------------------------------------------- model listing

func (rl *Relay) handleModels(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, status, err := rl.authenticate(ctx, r)
	if err != nil {
		writeError(w, status, "authentication_error", "", err.Error())
		return
	}

	models, err := rl.st.GroupModels(ctx, p.group())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "server_error", "", err.Error())
		return
	}
	models = filterAllowed(models, p.token.AllowedModels)

	// GET /v1/models/{id}
	if id := strings.TrimPrefix(r.URL.Path, "/v1/models/"); id != "" && id != r.URL.Path {
		for _, m := range models {
			if m == id {
				writeJSON(w, http.StatusOK, modelCard(m))
				return
			}
		}
		writeError(w, http.StatusNotFound, "invalid_request_error", "model_not_found",
			fmt.Sprintf("the model %q does not exist or you do not have access to it", id))
		return
	}

	cards := make([]map[string]any, 0, len(models))
	for _, m := range models {
		cards = append(cards, modelCard(m))
	}
	writeJSON(w, http.StatusOK, map[string]any{"object": "list", "data": cards})
}

func modelCard(id string) map[string]any {
	return map[string]any{
		"id":       id,
		"object":   "model",
		"created":  0,
		"owned_by": "faketoken",
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func filterAllowed(models, allowed []string) []string {
	if len(allowed) == 0 {
		return models
	}
	set := make(map[string]struct{}, len(allowed))
	for _, a := range allowed {
		set[a] = struct{}{}
	}
	out := make([]string, 0, len(models))
	for _, m := range models {
		if _, ok := set[m]; ok {
			out = append(out, m)
		}
	}
	return out
}

// -------------------------------------------------------------- relay handler

// call is what one relayed request carries from ServeHTTP to the row that logs
// it, so the steps along the way share one handle instead of the same eight
// arguments.
type call struct {
	w http.ResponseWriter
	// r is replaced once the call can be cancelled from the console: from then
	// on it carries the context this process owns, not only the caller's.
	r        *http.Request
	p        *principal
	entry    *model.RequestLog
	captured *capturedRequest
	info     requestInfo
	body     []byte
	// protocol is the dialect the caller speaks, resolved once from the path:
	// routing filters on it and the User-Agent lock is keyed by it.
	protocol string
	started  time.Time
}

// reject answers a request without any upstream being involved, and logs it.
// logged is the text the row keeps when it should differ from what the caller
// reads — the operator's reason against the caller's; empty keeps them the
// same.
func (rl *Relay) reject(c *call, status int, errType, code, message, logged string) {
	if logged == "" {
		logged = message
	}
	rl.finish(c, status, logged)
	writeError(c.w, status, errType, code, message)
}

func (rl *Relay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	started := time.Now()
	ctx := r.Context()

	p, status, err := rl.authenticate(ctx, r)
	if err != nil {
		writeError(w, status, "authentication_error", "", err.Error())
		return
	}

	// The key's own rate limit, checked before the body is even read: a
	// throttled request should cost nothing and reach no upstream. The
	// channel limits further down belong to the operator; this one belongs
	// to the token itself.
	if allowed, retryAfter := rl.tokenLimiter.allow(p.token.ID, p.token.RPMLimit); !allowed {
		wait := int(retryAfter.Seconds()) + 1
		w.Header().Set("Retry-After", fmt.Sprintf("%d", wait))
		writeError(w, http.StatusTooManyRequests, "rate_limit_error", "",
			fmt.Sprintf("this API key is limited to %d requests per minute; retry in %ds",
				p.token.RPMLimit, wait))
		return
	}

	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "",
			"request body too large or unreadable: "+err.Error())
		return
	}
	_ = r.Body.Close()

	info := inspect(r.URL.Path, r.Header.Get("Content-Type"), body)
	entry := &model.RequestLog{
		// A placeholder, replaced by the database on insert. It exists so the
		// in-flight view can show when a call started; the stored row is
		// timestamped when it settles, which for a long stream is a very
		// different moment.
		CreatedAt: started,
		UserID:    p.user.ID,
		Username:  p.user.Username,
		TokenID:   p.token.ID,
		TokenName: p.token.Name,
		Model:     info.Model,
		Endpoint:  r.URL.Path,
		Method:    r.Method,
		Stream:    info.Stream,
		ClientIP:  clientIP(r),
		// Read from what the caller already sent. A channel with a thinking-level
		// mapping rewrites this per attempt to say what the upstream received.
		ReasoningEffort: info.Effort,
		ClientType:      clientType(r),
	}
	c := &call{
		w: w, r: r, p: p, entry: entry, info: info, body: body, started: started,
		// Only the cheap half is done here; the body is converted later, off
		// the path the caller is waiting on.
		captured: captureRequest(r, body),
		protocol: protocolFromPath(r.URL.Path),
	}

	// Checked before routing, pricing or quota: a blocked body should cost
	// nothing beyond reading it, and must never reach an upstream.
	if hit, blocked := rl.matchBlocked(body); blocked {
		// The group and the keyword go to the operator's log, never to the
		// caller. Telling the sender which word tripped would turn every
		// rejection into a probe that maps out the list.
		slog.Warn("blocked a request by keyword",
			"rule", hit.rule, "keyword", hit.keyword,
			"user", p.user.Username, "token", p.token.Name,
			"model", info.Model, "ip", entry.ClientIP)

		// Both come from the group that matched: its own status if it set one,
		// and one reply drawn from its pool.
		status, reply := hit.status, hit.reply

		// A success is answered like a model would answer, in whichever
		// dialect the caller used. Endpoints that expect something other than
		// prose — embeddings, audio, images — are refused instead: a text
		// reply where a vector belongs surfaces as a parse failure and sends
		// the operator looking in the wrong place.
		dialect := cannedDialectFor(r.URL.Path)
		if status < 400 && dialect != cannedNone {
			// Estimated from what was actually sent and what is being sent
			// back, so the reply carries the kind of counts a real answer
			// would rather than a conspicuous pair of zeroes.
			usage := cannedUsage{
				Prompt:     estimateTokens(string(body)),
				Completion: estimateTokens(reply),
			}
			sent := writeCannedReply(w, dialect, info.Model, info.Stream, reply, usage)
			c.captured.responseBody = sent
			c.captured.responseHeaders = map[string][]string{
				"Content-Type": {w.Header().Get("Content-Type")},
			}
			// Logged with the status the caller saw, and the group and keyword
			// in the error field so these stay findable under the "only errors"
			// filter even when that status is a 200.
			rl.finish(c, status, hit.logMessage())
			return
		}

		// Refused, for one of two reasons, and the message differs by which.
		//
		// If the operator chose an error status, their text is the message
		// they want the caller to read. If instead we are here only because
		// this endpoint cannot carry prose — an embeddings caller expects
		// vectors, and a 200 with an error body is a response no client can
		// make sense of — then their text was written to be an answer, not an
		// error, and a generic refusal reads better than a poem in an error
		// field.
		message := reply
		if status < 400 {
			status = http.StatusUnauthorized
			message = "the request was rejected by this gateway's content policy"
		}
		rl.reject(c, status, "invalid_request_error", "content_blocked", message, hit.logMessage())
		return
	}

	if info.Model == "" {
		rl.reject(c, http.StatusBadRequest, "invalid_request_error", "model_required",
			"could not determine the target model from the request", "")
		return
	}

	if len(p.token.AllowedModels) > 0 && len(filterAllowed([]string{info.Model}, p.token.AllowedModels)) == 0 {
		rl.reject(c, http.StatusForbidden, "invalid_request_error", "model_not_allowed",
			fmt.Sprintf("the model %q is not permitted for this API key", info.Model),
			fmt.Sprintf("model %q is not allowed for this API key", info.Model))
		return
	}

	candidates, err := rl.st.Candidates(ctx, p.group(), info.Model, c.protocol)
	if err != nil {
		rl.reject(c, http.StatusInternalServerError, "server_error", "", err.Error(), "")
		return
	}
	if len(candidates) == 0 {
		rl.reject(c, http.StatusNotFound, "invalid_request_error", "model_not_found",
			fmt.Sprintf("no channel in group %q currently serves the model %q", p.group(), info.Model), "")
		return
	}

	// The model is routable, so this request would really spend the operator's
	// money. Refuse before touching an upstream if nobody has priced it: usage
	// only becomes known after the answer, and an unbillable answer is a gift.
	if rl.pricer.Blocked(info.Model) {
		slog.Warn("refused an unpriced model",
			"model", info.Model, "user", p.user.Username, "token", p.token.Name)
		rl.reject(c, http.StatusForbidden, "invalid_request_error", "model_not_priced",
			fmt.Sprintf("the model %q has no price configured on this gateway; "+
				"ask an administrator to set one before using it", info.Model),
			"model has no price configured")
		return
	}

	// Past this point the call belongs to an upstream and may take minutes, so
	// the consoles hear about it now instead of only when it settles.
	c.captured.liveKey = rl.beginLive(entry)
	defer rl.endLive(c.captured.liveKey)

	// A call that can be watched should be stoppable. From here the request
	// runs on a context this process can cancel, not only the one the client
	// owns, so an operator can end a run that is burning money on an upstream
	// that will never answer.
	if c.captured.liveKey != "" {
		cancellable, cancel := context.WithCancelCause(r.Context())
		// nil keeps the cause the operator's cancel already set; on the
		// ordinary path there is none and this is just the leak check.
		defer cancel(nil)
		rl.cancels.add(c.captured.liveKey, cancel)
		defer rl.cancels.drop(c.captured.liveKey)
		c.r = r.WithContext(cancellable)
	}

	rl.dispatch(c, order(candidates))
}

// dispatch walks the ordered candidate list until one upstream answers.
func (rl *Relay) dispatch(c *call, candidates []model.Candidate) {
	w, r, entry, captured, info, body := c.w, c.r, c.entry, c.captured, c.info, c.body
	ctx := r.Context()
	// How many channels one request may visit. A channel's own retry_count is
	// spent on top of this, so the worst case is channels × (1 + retry_count)
	// upstream calls.
	channelBudget := min(rl.retryBudgetValue(), len(candidates))

	var (
		lastStatus  int
		lastMessage string
		attempts    int
		lastOutcome attemptOutcome
		// refusedAttachment records that at least one channel was passed over
		// because it does not take attachments, so the request can be answered
		// with that reason when nothing else was left to try.
		refusedAttachment bool
	)

	// Deciding whether the body carries an attachment means parsing all of it,
	// and a conversation replayed by a coding agent runs to megabytes. Parsed
	// at most once, and only if a candidate actually needs the answer: most
	// channels take attachments and never ask.
	hasAttachment := sync.OnceValue(func() bool {
		return hasConversationAttachment(r.Header.Get("Content-Type"), body)
	})

	// Channels that recently failed move to the back of the queue instead of
	// being dropped: a degraded upstream still beats a hard failure when it is
	// the only one left that serves the model.
	healthy := make([]model.Candidate, 0, len(candidates))
	cooling := make([]model.Candidate, 0, len(candidates))
	for _, cand := range candidates {
		if rl.breaker.tripped(cand.ChannelID) {
			cooling = append(cooling, cand)
		} else {
			healthy = append(healthy, cand)
		}
	}

	visited := 0
	for _, cand := range append(healthy, cooling...) {
		if visited >= channelBudget {
			break
		}

		ch, err := rl.st.GetChannel(ctx, cand.ChannelID)
		if err != nil {
			continue
		}
		// A channel that does not take attachments is passed over, not the
		// request refused: another candidate may well take them. Like the RPM
		// skip below, it costs no budget and no rate-limit slot.
		if !ch.AllowAttachments && hasAttachment() {
			refusedAttachment = true
			continue
		}

		// Per-channel RPM cap. A channel over its rate is treated like a
		// cooling breaker: skipped this pass, not counted as an attempt, so
		// a sibling channel at the same priority gets the request instead.
		if allowed, _ := rl.limiter.allow(cand.ChannelID, cand.RPMLimit); !allowed {
			if lastStatus == 0 {
				lastStatus = http.StatusTooManyRequests
				lastMessage = fmt.Sprintf("channel %q is rate limited (RPM %d)", ch.Name, cand.RPMLimit)
			}
			continue
		}

		visited++

		// The channel's own retry allowance is spent before the request moves
		// on: an upstream that answers on the second try is cheaper than
		// another provider with another rate and another model vocabulary.
		//
		// ponytail: the RPM limiter counted this channel once, above, so its own
		// retries can push the real request rate past rpm_limit. Re-check allow()
		// per attempt if that ever matters.
		base, ceiling := rl.retryBackoffValue(), maxRetryPause

	retrying:
		for attempt := 0; ; attempt++ {
			if attempt > 0 {
				// Its own pacing spaces its own retries; the global one spaces the
				// move to the next channel.
				base, ceiling = rl.retryBackoffValue(), maxChannelRetryPause
				if own := time.Duration(ch.RetryBackoffMS) * time.Millisecond; own > 0 {
					base = own
				}
			}
			if attempts > 0 && !pauseBeforeRetry(ctx, attempts, base, ceiling) {
				// The caller hung up while we were backing off.
				return
			}
			attempts++
			entry.Retries = int32(attempts - 1)
			// Re-announced per attempt: a console watching this call should name
			// the upstream it is actually waiting on, and a retry moves it
			// elsewhere.
			rl.routeLive(captured.liveKey, entry, ch)

			outcome := rl.attempt(c, ch)
			switch outcome.kind {
			case outcomeDone:
				if outcome.streamFailed {
					// The client already has the upstream's 2xx and its bytes, so
					// this cannot be retried — but the channel just failed, and
					// leaving the breaker to think otherwise would keep sending
					// traffic to an upstream that is refusing it.
					rl.breaker.fail(ch.ID, outcome.retryAfter)
					slog.Warn("upstream reported an error inside a successful response",
						"channel", ch.Name, "channel_id", ch.ID, "model", info.Model,
						"status", outcome.status, "error", outcome.message)
				} else {
					rl.breaker.succeed(ch.ID)
				}
				rl.settle(c, ch, outcome)
				return
			case outcomeAborted:
				// The client hung up, an operator stopped the call, or the stream
				// broke after headers were sent. Retrying would corrupt a response
				// the caller is already holding.
				//
				// An abort that landed before the upstream's headers has written
				// nothing, and returning here would let net/http answer with its
				// default empty 200 — which nobody was there to read when the
				// caller hung up, but is a flat lie when an operator killed the
				// call and the caller is still on the line waiting.
				if !outcome.headersSent {
					writeError(w, statusClientClosedRequest, "request_cancelled",
						"cancelled", outcome.message)
				}
				rl.settle(c, ch, outcome)
				return
			case outcomeRetry:
				lastStatus, lastMessage = outcome.status, outcome.message
				lastOutcome = outcome
				rl.noteFailure(ctx, ch, outcome)
				slog.Warn("relay attempt failed",
					"channel", ch.Name, "channel_id", ch.ID, "model", info.Model,
					"status", outcome.status, "error", outcome.message)
				// Either the channel's own allowance is spent, or the upstream
				// refused the request itself and would refuse it again verbatim.
				// Both mean this channel is done and the request moves on.
				if attempt >= int(ch.RetryCount) || !retryableOnSameChannel(outcome) {
					break retrying
				}
			}
		}
	}

	// Nothing was tried and the only reason is the attachment. Answered as
	// its own error rather than as a failed attempt: no upstream was involved,
	// and the caller can act on it by dropping the attachment. A rate-limit
	// skip outranks it when both happened, because that one clears by itself
	// on retry. Neither the channel nor its name is disclosed.
	if attempts == 0 && refusedAttachment && lastStatus == 0 {
		rl.reject(c, http.StatusTooManyRequests, "invalid_request_error", "attachments_not_allowed",
			"请求不能携带附件", "")
		return
	}

	if lastStatus == 0 {
		lastStatus = http.StatusServiceUnavailable
		lastMessage = "every candidate channel is unavailable"
	}
	applyResponseDetails(captured, lastOutcome)
	rl.reject(c, lastStatus, "upstream_error", "",
		fmt.Sprintf("all %d attempt(s) failed: %s", max(attempts, 1), lastMessage), lastMessage)
}

type outcomeKind int

const (
	outcomeRetry outcomeKind = iota
	outcomeDone
	outcomeAborted
)

type attemptOutcome struct {
	kind    outcomeKind
	status  int
	message string
	// streamFailed marks a call the upstream answered 2xx and then failed
	// inside the body — an SSE error event, or a JSON error object. The bytes
	// are already on the wire, so the status cannot be changed for the caller;
	// this flag is what tells the breaker and the channel counters that the
	// call did not work. A rate limit inside the body additionally rewrites
	// status to 429, which is the status every bookkeeping decision reads.
	streamFailed bool
	// headersSent marks a call whose upstream response headers already reached
	// the caller. It decides whether an abort still has a response to write:
	// after this point the status line is spent and the only honest ending is
	// to stop sending bytes.
	headersSent       bool
	usage             model.Usage
	hasUsage          bool
	ttfb              time.Duration
	retryAfter        time.Duration
	responseHeaders   map[string][]string
	responseBody      string
	responseTruncated bool
}

// attempt performs one upstream call. On success it streams the response
// straight to the client; on a retryable failure it consumes and reports the
// upstream error without touching the client connection.
func (rl *Relay) attempt(c *call, ch *model.Channel) attemptOutcome {
	w, r, entry, info, body, protocol := c.w, c.r, c.entry, c.info, c.body, c.protocol

	baseURL := ch.BaseURL

	upstreamModel := ch.UpstreamModel(info.Model)
	path := r.URL.Path
	outBody := body

	if upstreamModel != info.Model {
		if provider.ModelInPath(path) {
			path = provider.ReplaceGeminiModelInPath(path, info.Model, upstreamModel)
		}
		if info.IsJSON && len(body) > 0 {
			outBody = rewriteModel(body, upstreamModel)
		}
	}

	// Applied to outBody rather than body so it composes with a mapped model.
	//
	// The log line is rebuilt on every attempt rather than only when a rule
	// fires. Each retry is a different channel with its own vocabulary, so a
	// rename by a channel that then failed must not be left standing against
	// the one that actually answered.
	entry.ReasoningEffort = info.Effort
	if info.IsJSON && len(outBody) > 0 {
		// Resolved against the model the caller asked for, not the one a model
		// mapping rewrites it to: that is the name the operator configures
		// against and sees in the channel's model list and in the log.
		rewritten, from, to := rewriteReasoningEffort(outBody, ch.EffortMappingFor(info.Model))
		if from != "" {
			outBody = rewritten
			// Keeps what the caller asked for and says what was sent instead: a
			// row reading plain "xhigh" would hide that the client requested
			// "max", which is the whole point of having the rule.
			entry.ReasoningEffort = from + " → " + to
		}
	}

	entry.ChannelID = ch.ID
	entry.ChannelName = ch.Name
	entry.UpstreamModel = upstreamModel

	target := provider.JoinURL(baseURL, path)
	if query := forwardableQuery(r.URL); query != "" {
		target += "?" + query
	}

	timeout := rl.cfg.RelayTimeout
	if ch.TimeoutSecs > 0 {
		timeout = time.Duration(ch.TimeoutSecs) * time.Second
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, r.Method, target, bytes.NewReader(outBody))
	if err != nil {
		return attemptOutcome{kind: outcomeRetry, status: http.StatusBadGateway, message: err.Error()}
	}
	copyRequestHeaders(req.Header, r.Header)
	provider.ApplyAuth(req, ch.APIKey, ch.AuthStyle)
	// Channel headers merge last by design: operators can override an unusual
	// upstream's authentication header without storing the key in plaintext a
	// second time, and can replace defaults such as anthropic-version.
	for k, v := range ch.Headers {
		req.Header.Set(k, v)
	}
	// The UA lock is keyed by the protocol sent upstream, which is the one the
	// caller used: requests are forwarded in their own dialect.
	upstreamProtocol := protocol
	incomingUA := strings.TrimSpace(r.Header.Get("User-Agent"))
	lockedUA := ""
	if upstreamProtocol != "" {
		var lockErr error
		lockedUA, lockErr = rl.st.GetChannelUserAgent(ctx, ch.ID, upstreamProtocol)
		if lockErr != nil {
			return attemptOutcome{kind: outcomeRetry, status: http.StatusInternalServerError,
				message: "could not read the channel User-Agent configuration: " + lockErr.Error()}
		}
		// An explicitly configured value always wins, even when automatic
		// locking is disabled, and wins over the channel's additional headers.
		if lockedUA != "" {
			req.Header.Set("User-Agent", lockedUA)
		} else if ch.LockUserAgent && incomingUA != "" {
			// Automatic mode also outranks an attached User-Agent while it is
			// waiting for the first successful response to establish the lock.
			req.Header.Set("User-Agent", incomingUA)
		}
	}
	req.ContentLength = int64(len(outBody))

	client, err := rl.clients.get(ch.ProxyURL)
	if err != nil {
		return attemptOutcome{kind: outcomeRetry, status: http.StatusBadGateway,
			message: "invalid channel proxy: " + err.Error()}
	}

	dialled := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		if r.Context().Err() != nil {
			return abortedOutcome(r.Context())
		}
		return attemptOutcome{kind: outcomeRetry, status: http.StatusBadGateway, message: err.Error()}
	}
	defer resp.Body.Close()
	headersAt := time.Now()

	if resp.StatusCode >= 400 && retryable(resp.StatusCode) {
		limit := rl.captureLimit()
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, int64(limit)+1))
		truncated := len(snippet) > limit
		if truncated {
			snippet = snippet[:limit]
		}
		responseBody, responseTruncated := sanitizeBody(resp.Header.Get("Content-Type"), snippet, truncated, limit)
		return attemptOutcome{
			kind:            outcomeRetry,
			status:          resp.StatusCode,
			message:         upstreamErrorMessage(snippet),
			retryAfter:      parseRetryAfter(resp.Header),
			responseHeaders: sanitizeHeaders(resp.Header), responseBody: responseBody,
			responseTruncated: responseTruncated,
		}
	}

	// From here the upstream owns the response: status, headers and bytes are
	// forwarded verbatim, including non-retryable 4xx errors.
	copyResponseHeaders(w.Header(), resp.Header)
	contentType := resp.Header.Get("Content-Type")
	isStream := info.Stream || strings.Contains(strings.ToLower(contentType), "event-stream")
	if isStream {
		w.Header().Set("X-Accel-Buffering", "no")
	}
	w.WriteHeader(resp.StatusCode)

	sniff := newUsageSniffer(contentType, rl.captureLimit())

	written, bodyTTFB, pumpErr := pump(w, resp.Body, sniff, isStream, rl.cfg.StreamIdleTimeout, cancel)

	usage, hasUsage := sniff.Usage()
	captured, captureTruncated := sniff.Capture()
	responseBody, responseTruncated := sanitizeBody(contentType, captured, captureTruncated, rl.captureLimit())
	out := attemptOutcome{
		kind: outcomeDone, status: resp.StatusCode,
		headersSent: true,
		usage:       usage, hasUsage: hasUsage,
		// Time to first byte spans the whole upstream call: an upstream may sit
		// on the response headers while the model is still thinking, so the
		// wait for headers counts just as much as the wait for the first chunk.
		ttfb:            headersAt.Sub(dialled) + bodyTTFB,
		responseHeaders: sanitizeHeaders(resp.Header), responseBody: responseBody,
		responseTruncated: responseTruncated,
	}
	if resp.StatusCode >= 400 {
		out.message = upstreamErrorMessage(sniff.Body())
	} else if failure, failed := sniff.StreamError(); failed {
		// A 2xx that carries an error object is a failure the status line hides.
		// Gateways under load answer 200 text/event-stream, ping a few times and
		// then end the stream with `{"type":"error",...}`; scored on the status
		// alone that call would be logged as a clean success.
		out.streamFailed = true
		out.message = streamFailureMessage(failure)
		out.retryAfter = parseRetryAfter(resp.Header)
		if failure.RateLimited() {
			// The caller already has the upstream's 2xx and its bytes, so the
			// wire status cannot change. Every later decision reads this field
			// though, so the call is recorded as the 429 it is: the log shows a
			// rate limit instead of a clean 200, and the partial usage is not
			// billed.
			out.status = http.StatusTooManyRequests
		}
	}
	if pumpErr != nil {
		out.kind = outcomeAborted
		out.message = "stream interrupted: " + pumpErr.Error()
		// An operator killed this one; say so rather than reporting the broken
		// pipe that killing it produced.
		if errors.Is(context.Cause(r.Context()), ErrCancelledByOperator) {
			out.message = cancelledMessage
		}
		// A broken pipe is the caller leaving, not the channel misbehaving.
		out.streamFailed = false
	}
	if (pumpErr == nil || written > 0) && resp.StatusCode >= 200 && resp.StatusCode < 300 &&
		!out.streamFailed &&
		ch.LockUserAgent && lockedUA == "" && incomingUA != "" && upstreamProtocol != "" {
		// A normal response locks after it has been fully relayed. Streaming
		// clients may close after receiving useful content; written > 0 treats
		// that accepted 2xx response as successful for UA learning as well.
		// A 2xx that failed inside the body teaches nothing: the upstream never
		// accepted the call, so its User-Agent is unproven.
		lockCtx, lockCancel := context.WithTimeout(context.Background(), 5*time.Second)
		winner, lockErr := rl.st.AutoLockChannelUserAgent(lockCtx, ch.ID, upstreamProtocol, incomingUA)
		lockCancel()
		if lockErr != nil {
			slog.Warn("could not auto-lock channel User-Agent", "channel_id", ch.ID,
				"protocol", upstreamProtocol, "error", lockErr)
		} else if winner != "" && winner != incomingUA {
			slog.Info("channel User-Agent auto-lock race resolved", "channel_id", ch.ID,
				"protocol", upstreamProtocol)
		}
	}
	return out
}

// cancelledMessage is what the log row reads when an operator ended the call.
const cancelledMessage = "cancelled by an administrator"

// statusClientClosedRequest is nginx's 499. Not an IANA code, but it is the one
// every log reader already understands as "nobody is waiting for this any
// more", and it is what the stored row has always carried for an aborted call.
const statusClientClosedRequest = 499

// abortedOutcome names why a call stopped. A cancelled context is all the
// request goroutine sees, and the cause is the only thing that still knows
// whether somebody pressed cancel or the caller simply went away.
func abortedOutcome(ctx context.Context) attemptOutcome {
	message := "client closed request"
	if errors.Is(context.Cause(ctx), ErrCancelledByOperator) {
		message = cancelledMessage
	}
	return attemptOutcome{kind: outcomeAborted, status: statusClientClosedRequest, message: message}
}

// forwardableQuery reproduces the caller's query string minus `key`, which
// Gemini-style clients use to carry *our* relay credential. Forwarding it
// would leak the caller's key to the upstream; every dialect gets its real
// credential from ApplyAuth instead.
func forwardableQuery(u *url.URL) string {
	if !u.Query().Has("key") {
		return u.RawQuery
	}
	query := u.Query()
	query.Del("key")
	return query.Encode()
}

// retryable decides whether another channel deserves a shot. Genuine client
// mistakes (400, 422) are the caller's problem and are surfaced as-is, while a
// 404 usually means this particular upstream does not carry the model, so the
// next channel is worth trying.
func retryable(status int) bool {
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
		http.StatusRequestTimeout, http.StatusTooManyRequests,
		http.StatusInternalServerError, http.StatusNotImplemented,
		http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout,
		524, 529:
		return true
	}
	return false
}

func upstreamErrorMessage(body []byte) string {
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

// streamFailureMessage renders an in-body failure for the log. The upstream's
// own status is spelled out because the log row shows the 2xx we relayed, and
// without it a 429 hidden inside a 200 looks like an unexplained failure.
func streamFailureMessage(failure provider.StreamError) string {
	parts := make([]string, 0, 3)
	if failure.Status != 0 {
		parts = append(parts, fmt.Sprintf("HTTP %d", failure.Status))
	}
	if failure.Type != "" {
		parts = append(parts, failure.Type)
	}
	if failure.Message != "" {
		parts = append(parts, failure.Message)
	}
	if len(parts) == 0 {
		parts = append(parts, "upstream reported an error")
	}
	return "上游在响应体中返回错误：" + strings.Join(parts, ": ")
}

// ------------------------------------------------------------- bookkeeping

// maxRetryPause bounds the wait before the request moves to another channel.
// Each attempt then targets a different channel, so waiting long here only
// delays a request that another upstream could already be serving; the real
// cooldown lives in the breaker.
const maxRetryPause = 2 * time.Second

// maxChannelRetryPause bounds the wait between two attempts at the same
// channel. Roomier than the global cap on purpose: waiting is the point here —
// the same upstream is being given time to recover — and the number is the
// operator's own.
const maxChannelRetryPause = 30 * time.Second

// DefaultRetryBudget is the fallback max retry count when no stored option
// exists. Matches the environment default for MAX_RETRIES.
const DefaultRetryBudget = 3

// DefaultRetryBackoff is the fallback inter-retry base delay when no stored
// option exists. Matches the environment default for RETRY_BACKOFF.
const DefaultRetryBackoff = 200 * time.Millisecond

// retryBudgetValue reads the operator-configured cap on how many channels one
// request may visit before it gives up. A channel's own retry_count is spent on
// top of it. Consulted per request, so it lives in memory rather than in the
// options table.
func (rl *Relay) retryBudgetValue() int {
	if n := int(rl.retryBudget.Load()); n > 0 {
		return n
	}
	return DefaultRetryBudget
}

// retryBackoffValue reads the operator-configured inter-retry base delay. It
// spaces the move to another channel; a channel that sets retry_backoff_ms
// spaces its own retries with that instead.
func (rl *Relay) retryBackoffValue() time.Duration {
	if d := time.Duration(rl.retryBackoff.Load()); d > 0 {
		return d
	}
	return DefaultRetryBackoff
}

// SetRetryConfig updates the retry attempt cap and the inter-retry backoff
// base without a restart. The cap counts channels, not attempts: it bounds how
// many upstreams one request may visit, each of which may be tried several
// times under its own retry_count.
func (rl *Relay) SetRetryConfig(maxRetries int, backoff time.Duration) {
	if maxRetries < 1 {
		maxRetries = 1
	}
	rl.retryBudget.Store(int64(maxRetries))
	if backoff > 0 {
		rl.retryBackoff.Store(int64(backoff))
	}
}

// retryableOnSameChannel reports whether repeating the call against the same
// upstream could plausibly answer differently. A refusal the request itself
// caused (a 4xx other than a rate limit) would come back verbatim, so the
// channel's retry allowance is not spent on it: the request moves on instead.
func retryableOnSameChannel(out attemptOutcome) bool {
	return out.status == 0 ||
		out.status == http.StatusTooManyRequests ||
		out.status >= http.StatusInternalServerError
}

// pauseBeforeRetry spaces out attempts so a struggling provider is not hit by a
// tight retry loop. base scales with the attempt number and the wait is capped
// at ceiling. It reports false when the caller disconnected while waiting.
func pauseBeforeRetry(ctx context.Context, attempt int, base, ceiling time.Duration) bool {
	delay := base * time.Duration(attempt)
	if delay <= 0 {
		return ctx.Err() == nil
	}
	if delay > ceiling {
		delay = ceiling
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func (rl *Relay) noteFailure(ctx context.Context, ch *model.Channel, out attemptOutcome) {
	detach := context.WithoutCancel(ctx)
	rl.breaker.fail(ch.ID, out.retryAfter)

	reason := fmt.Sprintf("HTTP %d: %s", out.status, out.message)
	rl.st.RecordChannelResult(detach, ch.ID, 0, reason)
}

// settle prices the request, debits the caller and writes the log entry.
func (rl *Relay) settle(c *call, ch *model.Channel, out attemptOutcome) {
	p, entry, captured := c.p, c.entry, c.captured

	entry.StatusCode = int32(out.status)
	entry.TTFBMS = int32(out.ttfb.Milliseconds())
	entry.DurationMS = int32(time.Since(c.started).Milliseconds())
	entry.Error = out.message
	entry.PromptTokens = int32(out.usage.PromptTokens)
	entry.CompletionTokens = int32(out.usage.CompletionTokens)
	entry.CachedTokens = int32(out.usage.CachedTokens)
	entry.CacheCreationTokens = int32(out.usage.CacheCreationTokens)
	entry.TotalTokens = int32(out.usage.TotalTokens)

	if out.status < 400 && out.hasUsage {
		var status billing.PriceStatus
		// The same group that chose the channel has to price the request;
		// routing by one group and billing by another would let a key reach a
		// pool at someone else's rate.
		entry.Cost, status = rl.pricer.Cost(entry.Model, out.usage, p.group(), ch.PriceRatio)
		// Reachable when the operator runs the "free" policy, or when a price
		// was deleted mid-flight. Never let it pass unnoticed.
		if status == billing.PriceMissing && !out.usage.IsZero() {
			slog.Warn("relayed an unpriced model for free — add a price entry",
				"model", entry.Model, "user", p.user.Username,
				"total_tokens", out.usage.TotalTokens)
		}
	}
	applyResponseDetails(captured, out)

	detached(func(ctx context.Context) {
		if entry.Cost > 0 {
			if err := rl.st.ConsumeQuota(ctx, p.user.ID, p.token.ID, entry.Cost); err != nil {
				slog.Error("quota settlement failed", "user", p.user.ID, "error", err)
			}
		}
		failure := ""
		if out.status >= 400 || out.streamFailed {
			failure = entry.Error
		}
		rl.st.RecordChannelResult(ctx, ch.ID, entry.Cost, failure)
		rl.PersistLog(ctx, entry, captured.liveKey, captured.detail)
	})
}

// finish logs a request that never reached an upstream.
func (rl *Relay) finish(c *call, status int, message string) {
	entry, captured := c.entry, c.captured
	entry.StatusCode = int32(status)
	entry.DurationMS = int32(time.Since(c.started).Milliseconds())
	entry.Error = message
	// No upstream answered, so the reply the caller got is the one this relay
	// wrote; the log shows that instead of nothing.
	if captured.responseBody == "" {
		body, _ := json.MarshalIndent(map[string]any{
			"error": map[string]any{"message": message, "status": status},
		}, "", "  ")
		captured.responseHeaders = map[string][]string{
			"Content-Type": {"application/json; charset=utf-8"},
		}
		captured.responseBody = string(body)
	}

	detached(func(ctx context.Context) {
		rl.PersistLog(ctx, entry, captured.liveKey, captured.detail)
	})
}

// logWriteBudget bounds the detached write of one log row and its bodies. It
// is independent of the request context on purpose: the caller may already be
// gone, and the row still has to land.
const logWriteBudget = 10 * time.Second

// detached runs fn on its own goroutine, off the path the caller is waiting on.
func detached(fn func(ctx context.Context)) {
	ctx, cancel := context.WithTimeout(context.Background(), logWriteBudget)
	go func() {
		defer cancel()
		fn(ctx)
	}()
}

// PersistLog stores the row, then its bodies, then tells the consoles. It is
// the one path every logged call goes through — relayed, refused, or probed
// from the console — so the three steps cannot drift apart.
//
// Detail before the announcement: a console that is told about a row opens it
// at once, and converting the bodies takes long enough for a large request
// that the reverse order would show "no longer retained" for a detail that
// was still being written.
//
// liveKey names the placeholder this row replaces; empty when nothing was
// announced. detail is called only when bodies are being retained, which is
// what keeps the conversion off the path when the window is closed.
func (rl *Relay) PersistLog(ctx context.Context, entry *model.RequestLog, liveKey string,
	detail func(limit int) *model.RequestLogDetail) {

	if err := rl.st.InsertLog(ctx, entry); err != nil {
		slog.Error("request log insert failed", "error", err)
		return
	}
	rl.recordDetail(ctx, entry.ID, detail)
	rl.publishLog(liveKey, entry)
}

// recordDetail converts the captured exchange and stores it.
func (rl *Relay) recordDetail(ctx context.Context, logID int64,
	detail func(limit int) *model.RequestLogDetail) {

	if logID == 0 {
		return
	}
	// Nothing is retained when the window is closed, so there is no reason to
	// pay for the conversion. The store still needs the call: turning the
	// setting off is what clears whatever was kept before.
	if !rl.st.LogDetailEnabled() {
		if err := rl.st.InsertLogDetail(ctx, &model.RequestLogDetail{LogID: logID}); err != nil {
			slog.Error("request detail clear failed", "log", logID, "error", err)
		}
		return
	}

	row := detail(rl.captureLimit())
	row.LogID = logID
	if err := rl.st.InsertLogDetail(ctx, row); err != nil {
		// A missing diagnostic body must never surface to the caller, whose
		// request has already been answered.
		slog.Error("request detail insert failed", "log", logID, "error", err)
	}
}

func applyResponseDetails(captured *capturedRequest, out attemptOutcome) {
	if out.responseHeaders != nil {
		captured.responseHeaders = out.responseHeaders
	}
	captured.responseBody = out.responseBody
	captured.responseTruncated = out.responseTruncated
}

// ----------------------------------------------------------------- headers

// hopByHop headers are connection-scoped and must never be forwarded.
var hopByHop = map[string]struct{}{
	"Connection":          {},
	"Proxy-Connection":    {},
	"Keep-Alive":          {},
	"Proxy-Authenticate":  {},
	"Proxy-Authorization": {},
	"Te":                  {},
	"Trailer":             {},
	"Transfer-Encoding":   {},
	"Upgrade":             {},
}

// stripped headers are either rewritten by the relay or would leak the
// caller's own credentials/session to the upstream.
var stripped = map[string]struct{}{
	"Host":             {},
	"Content-Length":   {},
	"Authorization":    {},
	"X-Api-Key":        {},
	"X-Goog-Api-Key":   {},
	"Cookie":           {},
	"Accept-Encoding":  {}, // let the transport negotiate so usage stays readable
	"X-Forwarded-For":  {},
	"X-Forwarded-Host": {},
	"X-Real-Ip":        {},
}

func copyRequestHeaders(dst, src http.Header) {
	skip := connectionTokens(src)
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if _, bad := hopByHop[canonical]; bad {
			continue
		}
		if _, bad := stripped[canonical]; bad {
			continue
		}
		if _, bad := skip[canonical]; bad {
			continue
		}
		for _, v := range values {
			dst.Add(canonical, v)
		}
	}
}

func copyResponseHeaders(dst, src http.Header) {
	skip := connectionTokens(src)
	for key, values := range src {
		canonical := http.CanonicalHeaderKey(key)
		if _, bad := hopByHop[canonical]; bad {
			continue
		}
		if _, bad := skip[canonical]; bad {
			continue
		}
		// The body length can change when the transport transparently
		// decompresses, so let net/http recompute it.
		if canonical == "Content-Length" {
			continue
		}
		for _, v := range values {
			dst.Add(canonical, v)
		}
	}
}

// connectionTokens returns the headers named by the Connection header, which
// RFC 9110 also marks as single-hop.
func connectionTokens(h http.Header) map[string]struct{} {
	out := map[string]struct{}{}
	for _, value := range h.Values("Connection") {
		for _, token := range strings.Split(value, ",") {
			if token = strings.TrimSpace(token); token != "" {
				out[http.CanonicalHeaderKey(token)] = struct{}{}
			}
		}
	}
	return out
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if idx := strings.IndexByte(xff, ','); idx > 0 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	if ip := r.Header.Get("X-Real-Ip"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
