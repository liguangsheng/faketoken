package api

import (
	"net/http"
	"strings"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	offset, limit := pagination(r)
	users, total, err := s.store.ListUsers(r.Context(), store.UserFilter{
		Keyword: r.URL.Query().Get("keyword"),
		Offset:  offset,
		Limit:   limit,
	})
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[*model.User]{Data: users, Total: total})
}

type userInput struct {
	Username    string  `json:"username"`
	Password    string  `json:"password"`
	DisplayName string  `json:"display_name"`
	Email       string  `json:"email"`
	Role        int16   `json:"role"`
	Status      int16   `json:"status"`
	Group       string  `json:"group"`
	QuotaUSD    float64 `json:"quota_usd"`
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var in userInput
	if !decode(w, r, &in) {
		return
	}
	if err := validateCredentials(credentials{Username: in.Username, Password: in.Password}); err != nil {
		fail(w, http.StatusBadRequest, err.Error())
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		failErr(w, err)
		return
	}

	user, err := s.store.CreateUser(r.Context(), &model.User{
		Username:     strings.TrimSpace(in.Username),
		PasswordHash: hash,
		DisplayName:  in.DisplayName,
		Email:        in.Email,
		Role:         normaliseRole(in.Role),
		Status:       normaliseStatus(in.Status),
		Group:        defaultString(in.Group, "default"),
		Quota:        billing.ParseUSD(in.QuotaUSD),
	})
	if err != nil {
		failErr(w, err)
		return
	}
	respond(w, http.StatusCreated, user)
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "user")
	if !valid {
		return
	}
	var in userInput
	if !decode(w, r, &in) {
		return
	}

	me := userFrom(r.Context())
	if me.ID == id && normaliseRole(in.Role) < model.RoleAdmin {
		fail(w, http.StatusBadRequest, "you cannot remove your own administrator role")
		return
	}

	existing, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	existing.DisplayName = in.DisplayName
	existing.Email = in.Email
	existing.Role = normaliseRole(in.Role)
	existing.Status = normaliseStatus(in.Status)
	existing.Group = defaultString(in.Group, "default")
	existing.Quota = billing.ParseUSD(in.QuotaUSD)

	updated, err := s.store.UpdateUser(r.Context(), existing)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, updated)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "user")
	if !valid {
		return
	}
	if me := userFrom(r.Context()); me.ID == id {
		fail(w, http.StatusBadRequest, "you cannot delete your own account")
		return
	}
	if err := s.store.DeleteUser(r.Context(), id); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "user deleted"})
}

func (s *Server) handleGrantQuota(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "user")
	if !valid {
		return
	}
	var in struct {
		AmountUSD float64 `json:"amount_usd"`
	}
	if !decode(w, r, &in) {
		return
	}
	if err := s.store.AddUserQuota(r.Context(), id, billing.ParseUSD(in.AmountUSD)); err != nil {
		failErr(w, err)
		return
	}
	user, err := s.store.GetUser(r.Context(), id)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, user)
}

func (s *Server) handleResetPassword(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "user")
	if !valid {
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	if len(in.Password) < 8 {
		fail(w, http.StatusBadRequest, "the password must be at least 8 characters")
		return
	}
	hash, err := auth.HashPassword(in.Password)
	if err != nil {
		failErr(w, err)
		return
	}
	// Ends the account's sessions as well: a reset is usually because someone
	// else may know the old password.
	if _, err := s.store.UpdateUserPassword(r.Context(), id, hash); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "password reset"})
}

// ------------------------------------------------------------------- groups

func (s *Server) handleListGroups(w http.ResponseWriter, r *http.Request) {
	groups, err := s.store.ListUserGroups(r.Context())
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"data": groups})
}

func (s *Server) handleUpsertGroup(w http.ResponseWriter, r *http.Request) {
	var in model.UserGroup
	if !decode(w, r, &in) {
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if in.Name == "" {
		fail(w, http.StatusBadRequest, "the group name is required")
		return
	}
	if in.Rate <= 0 {
		in.Rate = 1
	}
	if err := s.store.UpsertUserGroup(r.Context(), &in); err != nil {
		failErr(w, err)
		return
	}
	if err := s.pricer.Reload(r.Context()); err != nil {
		failErr(w, err)
		return
	}
	ok(w, in)
}

func (s *Server) handleDeleteGroup(w http.ResponseWriter, r *http.Request) {
	if err := s.store.DeleteUserGroup(r.Context(), r.PathValue("name")); err != nil {
		failErr(w, err)
		return
	}
	_ = s.pricer.Reload(r.Context())
	ok(w, map[string]string{"message": "group deleted"})
}

// ------------------------------------------------------------------ helpers

func normaliseRole(role int16) int16 {
	if role >= model.RoleAdmin {
		return model.RoleAdmin
	}
	return model.RoleUser
}

func normaliseStatus(status int16) int16 {
	if status == model.StatusDisabled {
		return model.StatusDisabled
	}
	return model.StatusEnabled
}

func defaultString(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return strings.TrimSpace(v)
}
