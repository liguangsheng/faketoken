package store

import (
	"context"

	"github.com/faketoken/faketoken/internal/model"
)

func (s *Store) ListPrices(ctx context.Context) ([]*model.ModelPrice, error) {
	rows, err := s.pool.Query(ctx, `SELECT model, input_price, output_price, cached_price,
		per_request_price, updated_at FROM model_prices ORDER BY model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*model.ModelPrice{}
	for rows.Next() {
		var p model.ModelPrice
		if err := rows.Scan(&p.Model, &p.InputPrice, &p.OutputPrice, &p.CachedPrice,
			&p.PerRequestPrice, &p.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, &p)
	}
	return out, rows.Err()
}

const upsertPriceSQL = `INSERT INTO model_prices
	(model, input_price, output_price, cached_price, per_request_price, updated_at)
	VALUES ($1,$2,$3,$4,$5, now())
	ON CONFLICT (model) DO UPDATE SET
		input_price = EXCLUDED.input_price,
		output_price = EXCLUDED.output_price,
		cached_price = EXCLUDED.cached_price,
		per_request_price = EXCLUDED.per_request_price,
		updated_at = now()`

const upsertOptionSQL = `INSERT INTO options (key, value, updated_at)
	VALUES ($1,$2, now())
	ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`

func (s *Store) UpsertPrice(ctx context.Context, p *model.ModelPrice) error {
	_, err := s.pool.Exec(ctx, upsertPriceSQL,
		p.Model, p.InputPrice, p.OutputPrice, p.CachedPrice, p.PerRequestPrice)
	return err
}

// UpsertPrices writes every row and stamps one option in a single
// transaction. A price import killed halfway must leave the table exactly as
// it was: a half-rewritten table bills a mix of old and new rates, and
// nothing records that it happened.
func (s *Store) UpsertPrices(ctx context.Context, rows []*model.ModelPrice, stampKey, stampValue string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful commit

	for _, p := range rows {
		if _, err := tx.Exec(ctx, upsertPriceSQL,
			p.Model, p.InputPrice, p.OutputPrice, p.CachedPrice, p.PerRequestPrice); err != nil {
			return err
		}
	}
	if stampKey != "" {
		if _, err := tx.Exec(ctx, upsertOptionSQL, stampKey, stampValue); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) DeletePrice(ctx context.Context, name string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM model_prices WHERE model = $1`, name)
	return err
}

// ------------------------------------------------------------------- options

func (s *Store) GetOption(ctx context.Context, key string) (string, error) {
	var v string
	err := s.pool.QueryRow(ctx, `SELECT value FROM options WHERE key = $1`, key).Scan(&v)
	if err != nil {
		return "", mapErr(err)
	}
	return v, nil
}

func (s *Store) SetOption(ctx context.Context, key, value string) error {
	_, err := s.pool.Exec(ctx, upsertOptionSQL, key, value)
	return err
}

// SetOptions writes several options as one change. A settings form is saved
// whole, and a write that stopped halfway would leave the stored policy as a
// mix of two versions nobody ever chose.
func (s *Store) SetOptions(ctx context.Context, values map[string]string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck // no-op after a successful commit

	for key, value := range values {
		if _, err := tx.Exec(ctx, upsertOptionSQL, key, value); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) AllOptions(ctx context.Context) (map[string]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT key, value FROM options`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}
