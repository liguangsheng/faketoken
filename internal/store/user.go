package store

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/faketoken/faketoken/internal/model"
)

const userColumns = `id, username, password_hash, display_name, email, role, status,
	user_group, quota, used_quota, request_count, created_at, updated_at, token_version`

func scanUser(row pgx.Row) (*model.User, error) {
	var u model.User
	err := row.Scan(&u.ID, &u.Username, &u.PasswordHash, &u.DisplayName, &u.Email,
		&u.Role, &u.Status, &u.Group, &u.Quota, &u.UsedQuota, &u.RequestCount,
		&u.CreatedAt, &u.UpdatedAt, &u.TokenVersion)
	if err != nil {
		return nil, mapErr(err)
	}
	return &u, nil
}

func (s *Store) CreateUser(ctx context.Context, u *model.User) (*model.User, error) {
	if err := s.CheckUsernameFree(ctx, u.Username); err != nil {
		return nil, err
	}

	row := s.pool.QueryRow(ctx, `INSERT INTO users
		(username, password_hash, display_name, email, role, status, user_group, quota)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING `+userColumns,
		u.Username, u.PasswordHash, u.DisplayName, u.Email, u.Role, u.Status, u.Group, u.Quota)
	return scanUser(row)
}

// CheckUsernameFree reports ErrDuplicate when the name is taken, ignoring case
// like every username lookup. The insert stays the authority: the name can be
// taken between this read and it.
func (s *Store) CheckUsernameFree(ctx context.Context, username string) error {
	var exists bool
	if err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM users WHERE lower(username) = lower($1))`, username).
		Scan(&exists); err != nil {
		return err
	}
	if exists {
		return fmt.Errorf("%w: username %q", ErrDuplicate, username)
	}
	return nil
}

func (s *Store) GetUser(ctx context.Context, id int64) (*model.User, error) {
	return scanUser(s.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*model.User, error) {
	return scanUser(s.pool.QueryRow(ctx,
		`SELECT `+userColumns+` FROM users WHERE lower(username) = lower($1)`, username))
}

func (s *Store) CountUsers(ctx context.Context) (int64, error) {
	var n int64
	err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users`).Scan(&n)
	return n, err
}

type UserFilter struct {
	Keyword string
	Offset  int
	Limit   int
}

func (s *Store) ListUsers(ctx context.Context, f UserFilter) ([]*model.User, int64, error) {
	where := "TRUE"
	args := []any{}
	if kw := strings.TrimSpace(f.Keyword); kw != "" {
		args = append(args, "%"+strings.ToLower(kw)+"%")
		where = fmt.Sprintf("(lower(username) LIKE $%d OR lower(display_name) LIKE $%d OR lower(email) LIKE $%d)",
			len(args), len(args), len(args))
	}

	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM users WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	args = append(args, f.Limit, f.Offset)
	q := fmt.Sprintf(`SELECT %s FROM users WHERE %s ORDER BY id DESC LIMIT $%d OFFSET $%d`,
		userColumns, where, len(args)-1, len(args))
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	users := []*model.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		users = append(users, u)
	}
	return users, total, rows.Err()
}

func (s *Store) UpdateUser(ctx context.Context, u *model.User) (*model.User, error) {
	row := s.pool.QueryRow(ctx, `UPDATE users SET
		display_name = $2, email = $3, role = $4, status = $5, user_group = $6,
		quota = $7, updated_at = now()
		WHERE id = $1 RETURNING `+userColumns,
		u.ID, u.DisplayName, u.Email, u.Role, u.Status, u.Group, u.Quota)
	return scanUser(row)
}

// UpdateUserPassword sets the hash and, in the same statement, bumps the token
// version, so no session from before the change survives it. Returns the new
// version for a caller that wants to stay signed in.
func (s *Store) UpdateUserPassword(ctx context.Context, id int64, hash string) (int32, error) {
	var version int32
	err := s.pool.QueryRow(ctx, `UPDATE users
		SET password_hash = $2, token_version = token_version + 1, updated_at = now()
		WHERE id = $1 RETURNING token_version`, id, hash).Scan(&version)
	return version, mapErr(err)
}

func (s *Store) UpdateUserProfile(ctx context.Context, id int64, displayName, email string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET display_name = $2, email = $3, updated_at = now() WHERE id = $1`,
		id, displayName, email)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, id int64) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// AddUserQuota tops up (or debits, with a negative delta) a user's balance.
func (s *Store) AddUserQuota(ctx context.Context, id int64, delta int64) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE users SET quota = quota + $2, updated_at = now() WHERE id = $1`, id, delta)
	return err
}

// ------------------------------------------------------------------- groups

func (s *Store) ListUserGroups(ctx context.Context) ([]*model.UserGroup, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT name, rate, description, created_at, user_selectable
		 FROM user_groups ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := []*model.UserGroup{}
	for rows.Next() {
		var g model.UserGroup
		if err := rows.Scan(&g.Name, &g.Rate, &g.Description, &g.CreatedAt,
			&g.UserSelectable); err != nil {
			return nil, err
		}
		groups = append(groups, &g)
	}
	return groups, rows.Err()
}

// SelectableGroups lists the groups a given account may point a key at: the
// one it already belongs to, plus any group an administrator has opened up.
func (s *Store) SelectableGroups(ctx context.Context, own string) ([]*model.UserGroup, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT name, rate, description, created_at, user_selectable
		 FROM user_groups WHERE user_selectable OR name = $1 ORDER BY name`, own)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	groups := []*model.UserGroup{}
	for rows.Next() {
		var g model.UserGroup
		if err := rows.Scan(&g.Name, &g.Rate, &g.Description, &g.CreatedAt,
			&g.UserSelectable); err != nil {
			return nil, err
		}
		groups = append(groups, &g)
	}
	return groups, rows.Err()
}

// GroupExists reports whether a group is defined, so a key cannot be pointed
// at one that was deleted or misspelled.
func (s *Store) GroupExists(ctx context.Context, name string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM user_groups WHERE name = $1)`, name).Scan(&exists)
	return exists, err
}

func (s *Store) UpsertUserGroup(ctx context.Context, g *model.UserGroup) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO user_groups (name, rate, description, user_selectable)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (name) DO UPDATE SET rate = EXCLUDED.rate,
			description = EXCLUDED.description, user_selectable = EXCLUDED.user_selectable`,
		g.Name, g.Rate, g.Description, g.UserSelectable)
	return err
}

func (s *Store) DeleteUserGroup(ctx context.Context, name string) error {
	if name == "default" {
		return fmt.Errorf("%w: the default group cannot be removed", ErrInvalidInput)
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM user_groups WHERE name = $1`, name)
	return err
}

func (s *Store) GroupRate(ctx context.Context, name string) (float64, error) {
	var rate float64
	err := s.pool.QueryRow(ctx, `SELECT rate FROM user_groups WHERE name = $1`, name).Scan(&rate)
	if err != nil {
		if err := mapErr(err); err == ErrNotFound {
			return 1, nil
		}
		return 1, err
	}
	return rate, nil
}
