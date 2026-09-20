package store

import (
	"context"

	"github.com/faketoken/faketoken/internal/model"
)

// ListKeepaliveChannels returns the channels configured for keepalive. Only
// the scheduler calls this, once a minute, and the set is small — the decision
// of whether a window is due is made in Go so it can be tested without a
// database.
func (s *Store) ListKeepaliveChannels(ctx context.Context) ([]*model.Channel, error) {
	// Archived channels are excluded: the whole point of the schedule is to
	// enable a channel on its own, which is exactly what archiving forbids.
	rows, err := s.pool.Query(ctx,
		`SELECT `+channelColumns+` FROM channels
		WHERE keepalive_enabled AND NOT archived ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	channels := []*model.Channel{}
	for rows.Next() {
		c, err := s.scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

// OpenKeepaliveWindow enables the channel and starts counting from zero.
//
// The routing tables carry their own copy of enabled, so they are flipped in
// the same transaction as the status — exactly as SetChannelStatus does.
// Without it the channel would read as enabled in the console while selection,
// which only ever reads abilities, still could not reach it.
func (s *Store) OpenKeepaliveWindow(ctx context.Context, id int64) error {
	return s.setKeepaliveWindow(ctx, id, true)
}

// CloseKeepaliveWindow disables the channel and stops the counter. The opened-at
// stamp is kept: it is what tells the scheduler today's window already ran.
func (s *Store) CloseKeepaliveWindow(ctx context.Context, id int64) error {
	return s.setKeepaliveWindow(ctx, id, false)
}

func (s *Store) setKeepaliveWindow(ctx context.Context, id int64, open bool) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	status := int16(model.StatusDisabled)
	if open {
		status = int16(model.StatusEnabled)
	}
	// Opening resets the counter and stamps the window; closing leaves both
	// alone so the console can still show what the window achieved.
	if open {
		if _, err := tx.Exec(ctx, `UPDATE channels
			SET status = $2, keepalive_open = TRUE, keepalive_success = 0,
			    keepalive_opened_at = now(), updated_at = now()
			WHERE id = $1`, id, status); err != nil {
			return err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE channels
		SET status = $2, keepalive_open = FALSE, updated_at = now()
		WHERE id = $1`, id, status); err != nil {
		return err
	}

	if _, err := tx.Exec(ctx, `UPDATE abilities SET enabled = $2 WHERE channel_id = $1`,
		id, open); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `UPDATE ability_prefixes SET enabled = $2 WHERE channel_id = $1`,
		id, open); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
