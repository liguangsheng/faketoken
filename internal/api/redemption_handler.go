package api

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/faketoken/faketoken/internal/auth"
	"github.com/faketoken/faketoken/internal/billing"
	"github.com/faketoken/faketoken/internal/model"
	"github.com/faketoken/faketoken/internal/store"
)

// maxRedemptionBatch bounds one generation request. A typo in the count field
// should not mint ten thousand codes.
const maxRedemptionBatch = 200

type redemptionInput struct {
	Name string `json:"name"`
	// Group makes the batch mutually exclusive: a user may claim only one of
	// its codes. Empty leaves the codes unrestricted.
	Group     string  `json:"group"`
	AmountUSD float64 `json:"amount_usd"`
	Count     int     `json:"count"`
	// ExpiresAt is optional; an empty string means the code never expires.
	ExpiresAt string `json:"expires_at"`
}

func (s *Server) handleCreateRedemptions(w http.ResponseWriter, r *http.Request) {
	var in redemptionInput
	if !decode(w, r, &in) {
		return
	}

	quota := billing.ParseUSD(in.AmountUSD)
	if quota <= 0 {
		fail(w, http.StatusBadRequest, "the amount must be greater than zero")
		return
	}
	count := in.Count
	if count <= 0 {
		count = 1
	}
	if count > maxRedemptionBatch {
		fail(w, http.StatusBadRequest, "at most 200 codes can be generated at once")
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

	codes := make([]*model.Redemption, 0, count)
	for i := 0; i < count; i++ {
		code, err := auth.GenerateRedemptionCode()
		if err != nil {
			failErr(w, err)
			return
		}
		codes = append(codes, &model.Redemption{
			Code:  code,
			Name:  strings.TrimSpace(in.Name),
			Group: strings.TrimSpace(in.Group),
			Quota: quota, ExpiresAt: expiresAt,
		})
	}

	created, err := s.store.CreateRedemptions(r.Context(), codes)
	if err != nil {
		failErr(w, err)
		return
	}
	slog.Info("redemption codes generated", "count", len(created), "amount_usd", in.AmountUSD)
	respond(w, http.StatusCreated, map[string]any{"data": created, "total": len(created)})
}

func (s *Server) handleListRedemptions(w http.ResponseWriter, r *http.Request) {
	offset, limit := pagination(r)
	codes, total, err := s.store.ListRedemptions(r.Context(), store.RedemptionFilter{
		Keyword: r.URL.Query().Get("keyword"),
		Status:  queryInt(r, "status", 0),
		Offset:  offset,
		Limit:   limit,
	})
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, page[*model.Redemption]{Data: codes, Total: total})
}

func (s *Server) handleRedemptionStatus(w http.ResponseWriter, r *http.Request) {
	id, err := pathID(r, "id")
	if err != nil {
		fail(w, http.StatusBadRequest, "invalid redemption id")
		return
	}
	var in struct {
		Status int16 `json:"status"`
	}
	if !decode(w, r, &in) {
		return
	}
	if in.Status != model.RedemptionUnused && in.Status != model.RedemptionDisabled {
		fail(w, http.StatusBadRequest, "status must be 1 (enabled) or 3 (disabled)")
		return
	}
	if err := s.store.SetRedemptionStatus(r.Context(), id, in.Status); err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]string{"message": "redemption updated"})
}

func (s *Server) handleDeleteRedemptions(w http.ResponseWriter, r *http.Request) {
	var in idsInput
	if !decode(w, r, &in) {
		return
	}
	ids, valid := validIDs(w, in.IDs, "兑换码")
	if !valid {
		return
	}
	deleted, err := s.store.DeleteRedemptions(r.Context(), ids)
	if err != nil {
		failErr(w, err)
		return
	}
	ok(w, map[string]any{"deleted": deleted})
}

// handleRedeem credits the signed-in user. Every failure reason is a 4xx with
// a specific message: the caller can act on each one, and none of them is a
// server fault.
func (s *Server) handleRedeem(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
	}
	if !decode(w, r, &in) {
		return
	}
	code := auth.NormalizeRedemptionCode(in.Code)
	if code == "" {
		fail(w, http.StatusBadRequest, "请输入兑换码")
		return
	}

	user := userFrom(r.Context())
	claimed, err := s.store.Redeem(r.Context(), code, user.ID, user.Username)
	if err != nil {
		switch {
		case errors.Is(err, store.ErrRedemptionNotFound):
			fail(w, http.StatusNotFound, "兑换码不存在")
		case errors.Is(err, store.ErrRedemptionUsed):
			fail(w, http.StatusConflict, "该兑换码已被使用")
		case errors.Is(err, store.ErrRedemptionDisabled):
			fail(w, http.StatusForbidden, "该兑换码已被停用")
		case errors.Is(err, store.ErrRedemptionExpired):
			fail(w, http.StatusForbidden, "该兑换码已过期")
		case errors.Is(err, store.ErrRedemptionGroupUsed):
			fail(w, http.StatusConflict, "您已使用过该活动的兑换码，每个活动仅限使用一个")
		default:
			failErr(w, err)
		}
		return
	}

	updated, err := s.store.GetUser(r.Context(), user.ID)
	if err != nil {
		failErr(w, err)
		return
	}
	slog.Info("redemption claimed",
		"user", user.Username, "code_id", claimed.ID, "quota", claimed.Quota)
	ok(w, map[string]any{
		"quota":   claimed.Quota,
		"balance": updated.Quota,
		"message": "兑换成功",
	})
}
