package store

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/model"
)

const tokenColumns = `id, user_id, name, key_hash, key_prefix, status, unlimited_quota,
	quota, used_quota, allowed_models, expires_at, last_used_at, created_at, updated_at,
	group_name`

func scanToken(row pgx.Row) (*model.Token, error) {
	var t model.Token
	err := row.Scan(&t.ID, &t.UserID, &t.Name, &t.KeyHash, &t.KeyPrefix, &t.Status,
		&t.UnlimitedQuota, &t.Quota, &t.UsedQuota, &t.AllowedModels, &t.ExpiresAt,
		&t.LastUsedAt, &t.CreatedAt, &t.UpdatedAt, &t.Group)
	if err != nil {
		return nil, mapErr(err)
	}
	if t.AllowedModels == nil {
		t.AllowedModels = []string{}
	}
	return &t, nil
}

// CreateToken stores the key twice over: a hash for the relay to authenticate
// against, and a ciphertext so the owner can copy it again later.
func (s *Store) CreateToken(ctx context.Context, t *model.Token) (*model.Token, error) {
	enc, err := s.cipher.Encrypt(t.Key)
	if err != nil {
		return nil, err
	}

	row := s.pool.QueryRow(ctx, `INSERT INTO tokens
		(user_id, name, key_hash, key_prefix, status, unlimited_quota, quota, allowed_models,
		 expires_at, group_name, key_enc)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING `+tokenColumns,
		t.UserID, t.Name, t.KeyHash, t.KeyPrefix, t.Status, t.UnlimitedQuota,
		t.Quota, t.AllowedModels, t.ExpiresAt, t.Group, enc)
	return scanToken(row)
}

// RevealToken returns the plaintext key for one row the caller owns.
//
// userID scopes the lookup rather than filtering afterwards, so another
// account's key is a miss rather than a leak. An empty result means the key
// predates encrypted storage and is genuinely unrecoverable.
func (s *Store) RevealToken(ctx context.Context, id, userID int64) (string, error) {
	where := "id = $1"
	args := []any{id}
	if userID > 0 {
		where += " AND user_id = $2"
		args = append(args, userID)
	}

	var enc string
	if err := s.pool.QueryRow(ctx,
		`SELECT key_enc FROM tokens WHERE `+where, args...).Scan(&enc); err != nil {
		return "", mapErr(err)
	}
	if enc == "" {
		return "", nil
	}
	return s.cipher.Decrypt(enc)
}

// GetTokenByHash is on the relay hot path: single indexed lookup by key hash.
func (s *Store) GetTokenByHash(ctx context.Context, hash string) (*model.Token, error) {
	return scanToken(s.pool.QueryRow(ctx,
		`SELECT `+tokenColumns+` FROM tokens WHERE key_hash = $1`, hash))
}

func (s *Store) GetToken(ctx context.Context, id int64) (*model.Token, error) {
	return scanToken(s.pool.QueryRow(ctx, `SELECT `+tokenColumns+` FROM tokens WHERE id = $1`, id))
}

func (s *Store) ListTokens(ctx context.Context, userID int64, offset, limit int) ([]*model.Token, int64, error) {
	where, args := "TRUE", []any{}
	if userID > 0 {
		args = append(args, userID)
		where = fmt.Sprintf("user_id = $%d", len(args))
	}

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM tokens WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, limit, offset)
	rows, err := s.pool.Query(ctx, fmt.Sprintf(
		`SELECT %s FROM tokens WHERE %s ORDER BY id DESC LIMIT $%d OFFSET $%d`,
		tokenColumns, where, len(args)-1, len(args)), args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	tokens := []*model.Token{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, 0, err
		}
		tokens = append(tokens, t)
	}
	return tokens, total, rows.Err()
}

func (s *Store) UpdateToken(ctx context.Context, t *model.Token) (*model.Token, error) {
	args := []any{t.ID, t.UserID, t.Name, t.Status, t.UnlimitedQuota, t.Quota,
		t.AllowedModels, t.ExpiresAt, t.Group}

	// An empty key means "leave it alone", the same contract the channel
	// credential uses, so an edit form never has to echo the secret back.
	keyClause := ""
	if t.Key != "" {
		enc, err := s.cipher.Encrypt(t.Key)
		if err != nil {
			return nil, err
		}
		args = append(args, t.KeyHash, t.KeyPrefix, enc)
		keyClause = fmt.Sprintf(", key_hash = $%d, key_prefix = $%d, key_enc = $%d",
			len(args)-2, len(args)-1, len(args))
	}

	row := s.pool.QueryRow(ctx, fmt.Sprintf(`UPDATE tokens SET
		name = $3, status = $4, unlimited_quota = $5, quota = $6,
		allowed_models = $7, expires_at = $8, group_name = $9%s, updated_at = now()
		WHERE id = $1 AND user_id = $2 RETURNING %s`, keyClause, tokenColumns), args...)
	return scanToken(row)
}

func (s *Store) DeleteToken(ctx context.Context, id, userID int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM tokens WHERE id = $1 AND user_id = $2`, id, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) TouchToken(ctx context.Context, id int64, at time.Time) {
	_, _ = s.pool.Exec(ctx, `UPDATE tokens SET last_used_at = $2 WHERE id = $1`, id, at)
}
