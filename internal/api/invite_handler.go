package api

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// maxInviteBatch bounds one generation request, for the same reason the
// redemption batch is bounded: a typo in the count field should not mint
// thousands of codes.
const maxInviteBatch = 200

type inviteInput struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	// ExpiresAt is optional; an empty string means the code never expires.
	ExpiresAt string `json:"expires_at"`
}

func (s *Server) handleCreateInviteCodes(w http.ResponseWriter, r *http.Request) {
	var in inviteInput
	if !decode(w, r, &in) {
		return
	}

	count := in.Count
	if count <= 0 {
		count = 1
	}
	if count > maxInviteBatch {
		fail(w, http.StatusBadRequest, "一次最多生成 200 个邀请码")
		return
	}

	var expiresAt *time.Time
	if raw := strings.TrimSpace(in.ExpiresAt); raw != "" {
		parsed, err := time.Parse(time.RFC3339, raw)
		if err != nil {
			fail(w, http.StatusBadRequest, "invalid expiry: use RFC3339")
			return
		}
		if !parsed.After(time.Now()) {
			fail(w, http.StatusBadRequest, "the expiry must be in the future")
			return
		}
		expiresAt = &parsed
	}

	codes := make([]*model.InviteCode, 0, count)
	for range count {
		code, err := auth.GenerateInviteCode()
		if err != nil {
			failErr(w, err)
			return
		}
		codes = append(codes, &model.InviteCode{
			Code:      code,
			Name:      strings.TrimSpace(in.Name),
			ExpiresAt: expiresAt,
		})
	}

	created, err := s.store.CreateInviteCodes(r.Context(), codes)
	if err != nil {
		failErr(w, err)
		return
	}
	slog.Info("invite codes generated", "count", len(created))
	respond(w, http.StatusCreated, map[string]any{"data": created, "total": len(created)})
}

func (s *Server) handleListInviteCodes(w http.ResponseWriter, r *http.Request) {
	offset, limit := pagination(r)
	codes, total, err := s.store.ListInviteCodes(r.Context(), store.InviteFilter{
		Keyword: r.URL.Query().Get("keyword"),
		Status:  int16(queryInt(r, "status", 0)),
		Offset:  offset,
		Limit:   limit,
	})
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[*model.InviteCode]{Data: codes, Total: total})
}

func (s *Server) handleInviteStatus(w http.ResponseWriter, r *http.Request) {
	id, valid := idParam(w, r, "invite")
	if !valid {
		return
	}
	var in struct {
		Status int16 `json:"status"`
	}
	if !decode(w, r, &in) {
		return
	}
	// A spent code cannot be revived: the account it created already exists.
	if in.Status != model.InviteUnused && in.Status != model.InviteDisabled {
		fail(w, http.StatusBadRequest, "status must be 1 (enabled) or 3 (disabled)")
		return
	}
	if err := s.store.SetInviteStatus(r.Context(), id, in.Status); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "invite updated"})
}

func (s *Server) handleDeleteInviteCodes(w http.ResponseWriter, r *http.Request) {
	var in idsInput
	if !decode(w, r, &in) {
		return
	}
	ids, valid := validIDs(w, in.IDs, "邀请码")
	if !valid {
		return
	}
	deleted, err := s.store.DeleteInviteCodes(r.Context(), ids)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"deleted": deleted})
}
