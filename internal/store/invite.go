package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/model"
)

var (
	ErrInviteNotFound = errors.New("invite code not found")
	ErrInviteUsed     = errors.New("invite code already used")
	ErrInviteDisabled = errors.New("invite code disabled")
	ErrInviteExpired  = errors.New("invite code expired")
)

const inviteColumns = `id, code, name, status, used_by, used_by_name, used_at,
	expires_at, created_at, updated_at`

func scanInvite(row pgx.Row) (*model.InviteCode, error) {
	var c model.InviteCode
	err := row.Scan(&c.ID, &c.Code, &c.Name, &c.Status, &c.UsedBy, &c.UsedByName,
		&c.UsedAt, &c.ExpiresAt, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, mapErr(err)
	}
	return &c, nil
}

// CreateInviteCodes inserts a batch in one transaction, so a half-written
// batch never reaches an administrator who is about to hand the codes out.
func (s *Store) CreateInviteCodes(ctx context.Context, codes []*model.InviteCode) ([]*model.InviteCode, error) {
	if len(codes) == 0 {
		return nil, fmt.Errorf("%w: no codes to create", ErrInvalidInput)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	out := make([]*model.InviteCode, 0, len(codes))
	for _, code := range codes {
		row := tx.QueryRow(ctx, `INSERT INTO invite_codes (code, name, expires_at)
			VALUES ($1,$2,$3) RETURNING `+inviteColumns,
			code.Code, code.Name, code.ExpiresAt)
		created, err := scanInvite(row)
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

type InviteFilter struct {
	Keyword string
	Status  int16
	Offset  int
	Limit   int
}

func (f InviteFilter) build() (string, []any) {
	conds := []string{"TRUE"}
	args := []any{}
	add := func(format string, value any) {
		args = append(args, value)
		conds = append(conds, fmt.Sprintf(format, len(args)))
	}
	if kw := strings.TrimSpace(f.Keyword); kw != "" {
		add(`(strpos(lower(code), lower($%[1]d)) > 0 OR strpos(lower(name), lower($%[1]d)) > 0
			OR strpos(lower(used_by_name), lower($%[1]d)) > 0)`, kw)
	}
	if f.Status > 0 {
		add("status = $%d", f.Status)
	}
	return strings.Join(conds, " AND "), args
}

func (s *Store) ListInviteCodes(ctx context.Context, f InviteFilter) ([]*model.InviteCode, int64, error) {
	where, args := f.build()

	var total int64
	if err := s.pool.QueryRow(ctx,
		`SELECT count(*) FROM invite_codes WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	limit := f.Limit
	if limit <= 0 {
		limit = 20
	}
	args = append(args, limit, f.Offset)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM invite_codes WHERE %s ORDER BY id DESC LIMIT $%d OFFSET $%d`,
		inviteColumns, where, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	out := []*model.InviteCode{}
	for rows.Next() {
		code, err := scanInvite(rows)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, code)
	}
	return out, total, rows.Err()
}

// SetInviteStatus enables or disables a code. A spent one cannot be put back
// into circulation: the account it created already exists.
func (s *Store) SetInviteStatus(ctx context.Context, id int64, status int16) error {
	tag, err := s.pool.Exec(ctx, `UPDATE invite_codes SET status = $2, updated_at = now()
		WHERE id = $1 AND status <> $3`, id, status, model.InviteUsed)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteInviteCodes removes codes. Spent ones are kept: they are the record of
// which invitation an account came from.
func (s *Store) DeleteInviteCodes(ctx context.Context, ids []int64) (int64, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM invite_codes WHERE id = ANY($1) AND status <> $2`,
		ids, model.InviteUsed)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// CreateUserWithInvite claims an invitation and creates the account in one
// transaction.
//
// The order matters and so does the transaction: claiming first means an
// invalid code is refused before any user row is written, and sharing the
// transaction means a signup that fails afterwards — a duplicate username,
// most likely — rolls the claim back instead of burning the invitation.
//
// The claim is a single UPDATE whose WHERE clause is the validation, the same
// technique redemptions use: checking first and writing afterwards would let
// two concurrent signups both pass the check.
func (s *Store) CreateUserWithInvite(ctx context.Context, u *model.User, code string) (*model.User, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	var inviteID int64
	err = tx.QueryRow(ctx, `UPDATE invite_codes
		SET status = $3, used_at = now(), updated_at = now()
		WHERE code = $1 AND status = $2
		  AND (expires_at IS NULL OR expires_at > now())
		RETURNING id`, code, model.InviteUnused, model.InviteUsed).Scan(&inviteID)
	if err != nil {
		if errors.Is(mapErr(err), ErrNotFound) {
			// Nothing was claimed. Read the row to say why, so the visitor
			// learns whether the code is wrong, spent, disabled or expired.
			return nil, s.explainInviteFailure(ctx, code)
		}
		return nil, mapErr(err)
	}

	// Kept for the friendlier message; the unique constraint below is what
	// actually holds under concurrency.
	var exists bool
	if err := tx.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1))`, u.Username).
		Scan(&exists); err != nil {
		return nil, err
	}
	if exists {
		return nil, fmt.Errorf("%w: username %q", ErrDuplicate, u.Username)
	}

	row := tx.QueryRow(ctx, `INSERT INTO users
		(username, password_hash, display_name, email, role, status, user_group, quota)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+userColumns,
		u.Username, u.PasswordHash, u.DisplayName, u.Email, u.Role, u.Status, u.Group, u.Quota)
	created, err := scanUser(row)
	if err != nil {
		return nil, err
	}

	// Recorded on the invitation rather than on the user: it answers "which
	// invitation was spent, and by whom" without widening the users table.
	if _, err := tx.Exec(ctx, `UPDATE invite_codes SET used_by = $2, used_by_name = $3
		WHERE id = $1`, inviteID, created.ID, created.Username); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return created, nil
}

// explainInviteFailure turns "nothing was claimed" into a reason. Read outside
// the caller's transaction, which is already destined to roll back.
func (s *Store) explainInviteFailure(ctx context.Context, code string) error {
	var status int16
	var expiresAt *time.Time
	err := s.pool.QueryRow(ctx,
		`SELECT status, expires_at FROM invite_codes WHERE code = $1`, code).
		Scan(&status, &expiresAt)
	if err != nil {
		return ErrInviteNotFound
	}
	switch {
	case status == model.InviteUsed:
		return ErrInviteUsed
	case status == model.InviteDisabled:
		return ErrInviteDisabled
	case expiresAt != nil && !expiresAt.After(time.Now()):
		return ErrInviteExpired
	}
	// The row looks usable now, so it was claimed between the failed UPDATE
	// and this read. Reporting it as spent is the accurate answer.
	return ErrInviteUsed
}
