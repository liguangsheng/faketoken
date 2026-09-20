package store

import (
	"context"

	"github.com/faketoken/faketoken/internal/model"
)

func (s *Store) ReplaceChannelModels(ctx context.Context, channelID int64, models []string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `DELETE FROM channel_models WHERE channel_id = $1`, channelID); err != nil {
		return err
	}
	for _, m := range models {
		if _, err := tx.Exec(ctx,
			`INSERT INTO channel_models (channel_id, model) VALUES ($1,$2)
			 ON CONFLICT (channel_id, model) DO UPDATE SET fetched_at = now()`,
			channelID, m); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE channels SET models_synced_at = now() WHERE id = $1`, channelID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ListChannelModels(ctx context.Context, channelID int64) ([]model.ChannelModel, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT channel_id, model, fetched_at FROM channel_models WHERE channel_id = $1 ORDER BY model`,
		channelID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []model.ChannelModel{}
	for rows.Next() {
		var cm model.ChannelModel
		if err := rows.Scan(&cm.ChannelID, &cm.Model, &cm.FetchedAt); err != nil {
			return nil, err
		}
		out = append(out, cm)
	}
	return out, rows.Err()
}

// SetChannelModels overwrites the served model list and refreshes routing.
func (s *Store) SetChannelModels(ctx context.Context, channelID int64, models []string) (*model.Channel, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	row := tx.QueryRow(ctx, `UPDATE channels SET models = $2, updated_at = now()
		WHERE id = $1 RETURNING `+channelColumns, channelID, models)
	updated, err := s.scanChannel(row)
	if err != nil {
		return nil, err
	}
	if err := rebuildAbilities(ctx, tx, updated); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return updated, nil
}
