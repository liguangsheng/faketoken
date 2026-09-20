package api

import (
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

type tokenInput struct {
	Name           string  `json:"name"`
	Status         int16   `json:"status"`
	UnlimitedQuota bool    `json:"unlimited_quota"`
	QuotaUSD       float64 `json:"quota_usd"`
	// RPMLimit caps this key's requests per minute; 0 means unlimited.
	RPMLimit      int32    `json:"rpm_limit"`
	AllowedModels []string `json:"allowed_models"`
	Group         string   `json:"group"`
	// Key sets the secret by hand. Empty generates one on create, and leaves
	// the existing one untouched on update.
	Key string `json:"key"`
	// ConfirmWeakKey acknowledges a key shorter than the recommended minimum.
	// Enforced server-side: a dialog in the console stops nobody from posting
	// straight to this endpoint.
	ConfirmWeakKey bool       `json:"confirm_weak_key"`
	ExpiresAt      *time.Time `json:"expires_at"`
}

// resolveKey turns the requested key into the three columns the store needs.
// An empty request means "generate" on create and "keep" on update, which the
// caller signals through generate.
func resolveKey(w http.ResponseWriter, in tokenInput, generate bool) (key, hash, prefix string, ok bool) {
	if strings.TrimSpace(in.Key) == "" {
		if !generate {
			return "", "", "", true // update: leave the existing key in place
		}
		key, hash, prefix, err := auth.GenerateAPIKey()
		if err != nil {
			failErr(w, err)
			return "", "", "", false
		}
		return key, hash, prefix, true
	}

	key, hash, prefix, err := auth.NormalizeCustomKey(in.Key, in.ConfirmWeakKey)
	switch {
	case errors.Is(err, auth.ErrWeakKey):
		fail(w, http.StatusBadRequest, fmt.Sprintf(
			"密钥少于 %d 位，请确认后重试", auth.MinRecommendedKeyLength))
		return "", "", "", false
	case err != nil:
		fail(w, http.StatusBadRequest, err.Error())
		return "", "", "", false
	}
	return key, hash, prefix, true
}

// failTokenKey reports a save failure. key_hash carries the only unique
// constraint on the table, so a duplicate here is always a key collision —
// worth saying plainly instead of returning the raw constraint violation.
func failTokenKey(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrDuplicate) {
		fail(w, http.StatusConflict, "该密钥已被占用，请换一个")
		return
	}
	failErr(w, err)
}

// resolveTokenGroup decides which group a key may carry, and refuses anything
// else.
//
// A group grants channel access *and* sets the price multiplier, so an
// unchecked value here would let any account award itself a cheaper rate or
// reach a pool it was never given. Restricting the choice in the console is
// not enough — this is the only place that actually holds.
func (s *Server) resolveTokenGroup(w http.ResponseWriter, r *http.Request, requested string) (string, bool) {
	me := userFrom(r.Context())
	requested = strings.TrimSpace(requested)

	// Empty keeps the historical behaviour: follow the owning account.
	if requested == "" || requested == me.Group {
		return requested, true
	}

	exists, err := s.store.GroupExists(r.Context(), requested)
	if err != nil {
		failErr(w, err)
		return "", false
	}
	if !exists {
		fail(w, http.StatusBadRequest, "分组不存在："+requested)
		return "", false
	}

	// An administrator already controls groups, rates and balances, so there
	// is nothing left to escalate.
	if me.IsAdmin() {
		return requested, true
	}

	groups, err := s.store.SelectableGroups(r.Context(), me.Group)
	if err != nil {
		failErr(w, err)
		return "", false
	}
	for _, group := range groups {
		if group.Name == requested {
			return requested, true
		}
	}
	fail(w, http.StatusForbidden, "该分组未对普通用户开放："+requested)
	return "", false
}

// handleMyGroups lists what the caller may pick, so the console offers exactly
// the set the server will accept.
func (s *Server) handleMyGroups(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())

	var groups []*model.UserGroup
	var err error
	if me.IsAdmin() {
		groups, err = s.store.ListUserGroups(r.Context())
	} else {
		groups, err = s.store.SelectableGroups(r.Context(), me.Group)
	}
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"data": groups, "own": me.Group})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	offset, limit := pagination(r)

	// Administrators may inspect another user's keys via ?user_id=
	target := me.ID
	if me.IsAdmin() {
		if requested := queryInt64(r, "user_id"); requested > 0 {
			target = requested
		}
	}

	tokens, total, err := s.store.ListTokens(r.Context(), target, offset, limit)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[*model.Token]{Data: tokens, Total: total})
}

func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var in tokenInput
	if !decode(w, r, &in) {
		return
	}
	me := userFrom(r.Context())

	group, allowed := s.resolveTokenGroup(w, r, in.Group)
	if !allowed {
		return
	}

	raw, hash, prefix, keyOK := resolveKey(w, in, true)
	if !keyOK {
		return
	}

	created, err := s.store.CreateToken(r.Context(), &model.Token{
		UserID:         me.ID,
		Name:           defaultString(in.Name, "default"),
		Key:            raw,
		KeyHash:        hash,
		KeyPrefix:      prefix,
		Status:         model.StatusEnabled,
		UnlimitedQuota: in.UnlimitedQuota,
		Quota:          billing.ParseUSD(in.QuotaUSD),
		RPMLimit:       max(in.RPMLimit, 0),
		AllowedModels:  nonNil(in.AllowedModels),
		Group:          group,
		ExpiresAt:      in.ExpiresAt,
	})
	if err != nil {
		failTokenKey(w, err)
		return
	}

	respond(w, http.StatusCreated, map[string]any{
		"token": created,
		"key":   raw,
	})
}

func (s *Server) handleUpdateToken(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "token")
	if !valid {
		return
	}
	var in tokenInput
	if !decode(w, r, &in) {
		return
	}
	me := userFrom(r.Context())

	// Checked on update too: creating a key with an allowed group and then
	// editing it into a privileged one would otherwise walk straight past the
	// check above.
	group, allowed := s.resolveTokenGroup(w, r, in.Group)
	if !allowed {
		return
	}

	// Empty leaves the existing secret in place, so an edit form never has to
	// receive the current key just to save an unrelated field.
	raw, hash, prefix, keyOK := resolveKey(w, in, false)
	if !keyOK {
		return
	}

	updated, err := s.store.UpdateToken(r.Context(), &model.Token{
		ID:             id,
		UserID:         me.ID,
		Name:           defaultString(in.Name, "default"),
		Key:            raw,
		KeyHash:        hash,
		KeyPrefix:      prefix,
		Status:         normaliseStatus(in.Status),
		UnlimitedQuota: in.UnlimitedQuota,
		Quota:          billing.ParseUSD(in.QuotaUSD),
		RPMLimit:       max(in.RPMLimit, 0),
		AllowedModels:  nonNil(in.AllowedModels),
		Group:          group,
		ExpiresAt:      in.ExpiresAt,
	})
	if err != nil {
		failTokenKey(w, err)
		return
	}
	ok(w, updated)
}

// handleRevealToken returns one key in plaintext so its owner can copy it
// again. Deliberately its own endpoint rather than a field on the list: a
// listing is fetched constantly and would spray every key through logs, proxy
// caches and browser history.
func (s *Server) handleRevealToken(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "token")
	if !valid {
		return
	}
	me := userFrom(r.Context())

	// Administrators can already reset any password and read any log; scoping
	// them out here would buy nothing and break support.
	owner := me.ID
	if me.IsAdmin() {
		owner = 0
	}

	key, err := s.store.RevealToken(r.Context(), id, owner)
	if err != nil {
		failErr(w, err)
		return
	}
	if key == "" {
		fail(w, http.StatusGone,
			"该密钥创建于此功能上线之前，原文无法找回；请新建一个密钥")
		return
	}
	ok(w, map[string]string{"key": key})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "token")
	if !valid {
		return
	}
	me := userFrom(r.Context())
	if err := s.store.DeleteToken(r.Context(), id, me.ID); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "API key deleted"})
}

func nonNil(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}
