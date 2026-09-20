package store

import (
	"context"
	"strings"

	"github.com/faketoken/faketoken/internal/model"
)

// GetChannelUserAgent reads the current protocol-specific value. Read per
// attempt rather than from the channel row loaded for routing, so a clear or
// an edit made in the console takes effect on the very next call.
func (s *Store) GetChannelUserAgent(ctx context.Context, id int64, protocol string) (string, error) {
	protocol = strings.TrimSpace(protocol)
	if protocol == "" {
		return "", ErrInvalidInput
	}
	var value string
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(locked_user_agents ->> $2, '')
		FROM channels WHERE id = $1`, id, protocol).Scan(&value)
	return strings.TrimSpace(value), mapErr(err)
}

// AutoLockChannelUserAgent learns a value only after the upstream call has
// succeeded. The conditional update makes concurrent successful first calls
// converge on one winner, while a manually configured value remains intact.
func (s *Store) AutoLockChannelUserAgent(ctx context.Context, id int64, protocol, candidate string) (string, error) {
	protocol = strings.TrimSpace(protocol)
	candidate = strings.TrimSpace(candidate)
	if protocol == "" || candidate == "" {
		return candidate, nil
	}
	var locked string
	err := s.pool.QueryRow(ctx, `UPDATE channels SET
		locked_user_agents = CASE
			WHEN lock_user_agent AND COALESCE(locked_user_agents ->> $2, '') = ''
			THEN jsonb_set(locked_user_agents, ARRAY[$2], to_jsonb($3::text), true)
			ELSE locked_user_agents
		END,
		updated_at = now()
		WHERE id = $1
		RETURNING COALESCE(locked_user_agents ->> $2, '')`, id, protocol, candidate).Scan(&locked)
	return strings.TrimSpace(locked), mapErr(err)
}

func (s *Store) ClearChannelUserAgent(ctx context.Context, id int64, protocol string) (*model.Channel, error) {
	protocol = strings.TrimSpace(protocol)
	if protocol == "" {
		return nil, ErrInvalidInput
	}
	return s.scanChannel(s.pool.QueryRow(ctx, `UPDATE channels
		SET locked_user_agents = locked_user_agents - $2, updated_at = now()
		WHERE id = $1 RETURNING `+channelColumns, id, protocol))
}
