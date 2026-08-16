package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/faketoken/faketoken/internal/model"
)

// Redemption outcomes a caller has to tell apart, because each one needs a
// different message and none of them is a server fault.
var (
	ErrRedemptionNotFound = errors.New("redemption code not found")
	ErrRedemptionUsed     = errors.New("redemption code already used")
	ErrRedemptionDisabled = errors.New("redemption code disabled")
	ErrRedemptionExpired  = errors.New("redemption code expired")
	// ErrRedemptionGroupUsed means the caller already claimed another code
	// from the same campaign.
	ErrRedemptionGroupUsed = errors.New("another code from this group was already used")
)

// groupClaimIndex is the partial unique index that makes "one per group per
// user" race-proof; a violation of it is that rule firing, not a bug.
const groupClaimIndex = "idx_redemptions_group_claimant"

const redemptionColumns = `id, code, name, group_name, quota, status, used_by, used_by_name,
	used_at, expires_at, created_at, updated_at`

func scanRedemption(row pgx.Row) (*model.Redemption, error) {
	var r model.Redemption
	if err := row.Scan(&r.ID, &r.Code, &r.Name, &r.Group, &r.Quota, &r.Status, &r.UsedBy,
		&r.UsedByName, &r.UsedAt, &r.ExpiresAt, &r.CreatedAt, &r.UpdatedAt); err != nil {
		return nil, mapErr(err)
	}
	return &r, nil
}

// isGroupClaimConflict reports whether the error is the group rule rather than
// some other unique violation, so a real duplicate is never mislabelled.
func isGroupClaimConflict(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) &&
		pgErr.Code == "23505" && pgErr.ConstraintName == groupClaimIndex
}

// CreateRedemptions inserts a batch in one transaction so a partially written
// batch never reaches an administrator who is about to hand the codes out.
func (s *Store) CreateRedemptions(ctx context.Context, codes []*model.Redemption) ([]*model.Redemption, error) {
	if len(codes) == 0 {
		return nil, fmt.Errorf("%w: no codes to create", ErrInvalidInput)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	out := make([]*model.Redemption, 0, len(codes))
	for _, code := range codes {
		row := tx.QueryRow(ctx, `INSERT INTO redemptions (code, name, group_name, quota, expires_at)
			VALUES ($1,$2,$3,$4,$5) RETURNING `+redemptionColumns,
			code.Code, code.Name, code.Group, code.Quota, code.ExpiresAt)
		created, err := scanRedemption(row)
		if err != nil {
			if errors.Is(err, ErrDuplicate) {
				return nil, fmt.Errorf("%w: code %q", ErrDuplicate, code.Code)
			}
			return nil, err
		}
		out = append(out, created)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// Redeem credits a user and consumes the code in a single transaction.
//
// Two different races are closed here, both by the database rather than by
// checking first and writing afterwards:
//
//   - The same code twice: the UPDATE only matches a row that is still unused,
//     so the loser matches nothing and is told the code is spent.
//   - Two codes from one group: the partial unique index on (group, claimant)
//     rejects the second claim.
func (s *Store) Redeem(ctx context.Context, code string, userID int64, username string) (*model.Redemption, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	row := tx.QueryRow(ctx, `UPDATE redemptions
		SET status = $3, used_by = $4, used_by_name = $5, used_at = now(), updated_at = now()
		WHERE code = $1 AND status = $2
		  AND (expires_at IS NULL OR expires_at > now())
		RETURNING `+redemptionColumns,
		code, model.RedemptionUnused, model.RedemptionUsed, userID, username)

	claimed, err := scanRedemption(row)
	if err != nil {
		if isGroupClaimConflict(err) {
			return nil, ErrRedemptionGroupUsed
		}
		if !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		// Nothing was claimed. Read the row to say why, so the user learns
		// whether the code is wrong, spent, disabled or expired.
		return nil, s.explainRedeemFailure(ctx, code)
	}

	if _, err := tx.Exec(ctx, `UPDATE users
		SET quota = quota + $2, updated_at = now() WHERE id = $1`,
		userID, claimed.Quota); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return claimed, nil
}

func (s *Store) explainRedeemFailure(ctx context.Context, code string) error {
	var status int16
	var expiresAt *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT status, expires_at FROM redemptions WHERE code = $1`, code).
		Scan(&status, &expiresAt)
	if err != nil {
		if errors.Is(mapErr(err), ErrNotFound) {
			return ErrRedemptionNotFound
		}
		return err
	}

	switch {
	case status == model.RedemptionUsed:
		return ErrRedemptionUsed
	case status == model.RedemptionDisabled:
		return ErrRedemptionDisabled
	case expiresAt != nil && !expiresAt.After(time.Now()):
		return ErrRedemptionExpired
	default:
		// The row became claimable again between the two statements, which
		// only happens if an administrator re-enabled it mid-flight.
		return ErrRedemptionUsed
	}
}

type RedemptionFilter struct {
	Keyword string
	Status  int
	Offset  int
	Limit   int
}

func (s *Store) ListRedemptions(ctx context.Context, f RedemptionFilter) ([]*model.Redemption, int64, error) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, value any) {
		args = append(args, value)
		conds = append(conds, fmt.Sprintf(format, len(args)))
	}
	if kw := strings.TrimSpace(f.Keyword); kw != "" {
		add(`(strpos(lower(code), lower($%[1]d)) > 0 OR strpos(lower(name), lower($%[1]d)) > 0
			OR strpos(lower(group_name), lower($%[1]d)) > 0
			OR strpos(lower(used_by_name), lower($%[1]d)) > 0)`, kw)
	}
	if f.Status > 0 {
		add("status = $%d", f.Status)
	}
	where := strings.Join(conds, " AND ")

	var total int64
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM redemptions WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, f.Limit, f.Offset)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM redemptions WHERE %s ORDER BY id DESC LIMIT $%d OFFSET $%d`,
		redemptionColumns, where, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []*model.Redemption{}
	for rows.Next() {
		entry, err := scanRedemption(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, entry)
	}
	return out, total, rows.Err()
}

// SetRedemptionStatus enables or disables a code. A spent code cannot be put
// back into circulation: its quota has already been credited.
func (s *Store) SetRedemptionStatus(ctx context.Context, id int64, status int16) error {
	tag, err := s.pool.Exec(ctx, `UPDATE redemptions SET status = $2, updated_at = now()
		WHERE id = $1 AND status <> $3`, id, status, model.RedemptionUsed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("%w: the code does not exist or has already been used", ErrInvalidInput)
	}
	return nil
}

// DeleteRedemptions removes codes. Spent ones are kept: they are the record of
// who was credited.
func (s *Store) DeleteRedemptions(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM redemptions WHERE id = ANY($1) AND status <> $2`,
		ids, model.RedemptionUsed)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
