package api

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

type credentials struct {
	Username string `json:"username"`
	Password string `json:"password"`
	// InviteCode is only read when registration requires one. Ignored by login
	// and by administrator-created accounts.
	InviteCode string `json:"invite_code"`
}

// failInvite reports a signup failure, translating the invitation reasons into
// something the visitor can act on.
func failInvite(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrInviteNotFound):
		fail(w, http.StatusBadRequest, "邀请码不存在")
	case errors.Is(err, store.ErrInviteUsed):
		fail(w, http.StatusConflict, "该邀请码已被使用")
	case errors.Is(err, store.ErrInviteDisabled):
		fail(w, http.StatusForbidden, "该邀请码已被停用")
	case errors.Is(err, store.ErrInviteExpired):
		fail(w, http.StatusForbidden, "该邀请码已过期")
	default:
		failErr(w, err)
	}
}

type sessionResponse struct {
	Token     string      `json:"token"`
	ExpiresAt string      `json:"expires_at"`
	User      *model.User `json:"user"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	ipKey, userKey := ipGuardKey(r), userGuardKey(in.Username)
	if s.throttled(w, ipKey, userKey) {
		return
	}

	user, err := s.store.GetUserByUsername(r.Context(), strings.TrimSpace(in.Username))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			// Same message, same bcrypt and same charge for an unknown user and
			// a wrong password: none of them may confirm which usernames exist.
			auth.CheckPassword(missHash(), in.Password)
			s.charge("login failed", ipKey, userKey)
			fail(w, http.StatusUnauthorized, "incorrect username or password")
			return
		}
		failErr(w, err)
		return
	}
	if !auth.CheckPassword(user.PasswordHash, in.Password) {
		s.charge("login failed", ipKey, userKey)
		fail(w, http.StatusUnauthorized, "incorrect username or password")
		return
	}
	s.guard.succeed(ipKey)
	s.guard.succeed(userKey)
	if user.Status != model.StatusEnabled {
		fail(w, http.StatusForbidden, "this account is disabled")
		return
	}

	token, expires, err := s.jwt.Issue(user.ID, user.Role, user.Username)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, sessionResponse{Token: token, ExpiresAt: expires.UTC().Format("2006-01-02T15:04:05Z"), User: user})
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	// Checked per request rather than at boot: an administrator closing
	// registration from the console has to take effect on the next attempt,
	// not the next restart.
	if !s.allowRegister(r.Context()) {
		fail(w, http.StatusForbidden, "self-registration is disabled")
		return
	}
	ipKey := ipGuardKey(r)
	if s.throttled(w, ipKey) {
		return
	}
	var in credentials
	if !decode(w, r, &in) {
		return
	}
	if err := validateCredentials(in); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}

	// Whether an invitation is needed is decided here, not by the form: the
	// register endpoint is reachable without ever loading the login page.
	needsInvite := s.requireInviteCode(r.Context())
	code := auth.NormalizeInviteCode(in.InviteCode)
	if needsInvite && code == "" {
		fail(w, http.StatusBadRequest, "注册需要邀请码")
		return
	}

	// Both checked before the bcrypt below, so a made-up code or a taken name
	// costs an indexed read rather than ~100ms of CPU. The writes further down
	// stay the authority: either answer can change before they run.
	if needsInvite {
		if err := s.store.CheckInviteCode(r.Context(), code); err != nil {
			// Only a code that does not exist is a guess. A spent, disabled or
			// expired one was real, and charging those would lock out the
			// losers of a race the claim settles anyway.
			if errors.Is(err, store.ErrInviteNotFound) {
				s.charge("signup with an unknown invite code", ipKey)
			}
			failInvite(w, err)
			return
		}
	}
	if err := s.store.CheckUsernameFree(r.Context(), strings.TrimSpace(in.Username)); err != nil {
		failErr(w, err)
		return
	}

	// Hashed before opening any transaction: bcrypt costs ~100ms, and holding
	// a connection for that long would exhaust the pool under load.
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		failErr(w, err)
		return
	}
	account := &model.User{
		Username:     strings.TrimSpace(in.Username),
		PasswordHash: hash,
		Role:         model.RoleUser,
		Status:       model.StatusEnabled,
		Group:        "default",
		// Resolved per registration so an administrator can change the grant
		// from the console without a restart.
		Quota: s.initQuota(r.Context()),
	}

	var user *model.User
	if needsInvite {
		// Claims the code and creates the account together, so a rejected
		// signup does not consume the invitation.
		user, err = s.store.CreateUserWithInvite(r.Context(), account, code)
	} else {
		user, err = s.store.CreateUser(r.Context(), account)
	}
	if err != nil {
		failInvite(w, err)
		return
	}

	token, expires, err := s.jwt.Issue(user.ID, user.Role, user.Username)
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, http.StatusCreated, sessionResponse{
		Token: token, ExpiresAt: expires.UTC().Format("2006-01-02T15:04:05Z"), User: user,
	})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	ok(w, userFrom(r.Context()))
}

func (s *Server) handleUpdateMe(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DisplayName string `json:"display_name"`
		Email       string `json:"email"`
	}
	if !decode(w, r, &in) {
		return
	}
	me := userFrom(r.Context())
	if err := s.store.UpdateUserProfile(r.Context(), me.ID, in.DisplayName, in.Email); err != nil {
		failErr(w, err)
		return
	}
	updated, err := s.store.GetUser(r.Context(), me.ID)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, updated)
}

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if !decode(w, r, &in) {
		return
	}
	me := userFrom(r.Context())
	// A stolen session must not become a way to guess the password, so this
	// shares the login lock for the account.
	userKey := userGuardKey(me.Username)
	if s.throttled(w, userKey) {
		return
	}
	if !auth.CheckPassword(me.PasswordHash, in.OldPassword) {
		s.charge("wrong current password", userKey)
		fail(w, http.StatusForbidden, "current password is incorrect")
		return
	}
	s.guard.succeed(userKey)
	if utf8.RuneCountInString(in.NewPassword) < 8 {
		fail(w, http.StatusBadRequest, "the new password must be at least 8 characters")
		return
	}
	hash, err := auth.HashPassword(in.NewPassword)
	if err != nil {
		failErr(w, err)
		return
	}
	if err := s.store.UpdateUserPassword(r.Context(), me.ID, hash); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "password updated"})
}

func (s *Server) handleMyModels(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	models, err := s.store.GroupModels(r.Context(), me.Group)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"data": models})
}

// plazaModel is one entry in the model plaza: a reachable model plus the base
// price it would be billed at. Prices are USD per 1M tokens before the group
// rate; the rate ships alongside so the console can show the effective number.
type plazaModel struct {
	Model           string  `json:"model"`
	InputPrice      float64 `json:"input_price"`
	OutputPrice     float64 `json:"output_price"`
	CachedPrice     float64 `json:"cached_price"`
	PerRequestPrice float64 `json:"per_request_price"`
	// PriceStatus says where the numbers came from: "exact" is a configured
	// entry, "fallback" the operator's default rate, "missing" no price at all
	// (listed only when the policy relays such a model for free).
	PriceStatus string `json:"price_status"`
}

// handleModelPlaza backs the console's model plaza: every model the caller's
// group can actually call, priced the way the caller would be billed.
//
// A model the relay would refuse for want of a price is left out rather than
// shown disabled: to the caller it does not exist. The operator finds those on
// the unpriced report instead.
func (s *Server) handleModelPlaza(w http.ResponseWriter, r *http.Request) {
	me := userFrom(r.Context())
	models, err := s.store.GroupModels(r.Context(), me.Group)
	if err != nil {
		failErr(w, err)
		return
	}

	entries := make([]plazaModel, 0, len(models))
	for _, name := range models {
		if s.pricer.Blocked(name) {
			continue
		}
		entry := plazaModel{Model: name}
		price, status := s.pricer.Resolve(name)
		entry.PriceStatus = status.String()
		if price != nil {
			entry.InputPrice = price.InputPrice
			entry.OutputPrice = price.OutputPrice
			entry.CachedPrice = price.CachedPrice
			entry.PerRequestPrice = price.PerRequestPrice
		}
		entries = append(entries, entry)
	}

	ok(w, map[string]any{
		"data":       entries,
		"group":      me.Group,
		"group_rate": s.pricer.GroupRate(me.Group),
		// Under reject no "missing" entry is listed; under free one means the
		// model relays without charge.
		"unpriced_policy": s.pricer.Settings().UnpricedPolicy,
	})
}

func validateCredentials(in credentials) error {
	username := strings.TrimSpace(in.Username)
	if n := utf8.RuneCountInString(username); n < 3 || n > 32 {
		return errors.New("the username must be between 3 and 32 characters")
	}
	if strings.ContainsAny(username, " \t\n/\\:@") {
		return errors.New("the username contains invalid characters")
	}
	if utf8.RuneCountInString(in.Password) < 8 {
		return errors.New("the password must be at least 8 characters")
	}
	return nil
}
