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

func (s *Store) UpsertPrice(ctx context.Context, p *model.ModelPrice) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO model_prices
		(model, input_price, output_price, cached_price, per_request_price, updated_at)
		VALUES ($1,$2,$3,$4,$5, now())
		ON CONFLICT (model) DO UPDATE SET
			input_price = EXCLUDED.input_price,
			output_price = EXCLUDED.output_price,
			cached_price = EXCLUDED.cached_price,
			per_request_price = EXCLUDED.per_request_price,
			updated_at = now()`,
		p.Model, p.InputPrice, p.OutputPrice, p.CachedPrice, p.PerRequestPrice)
	return err
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
	_, err := s.pool.Exec(ctx, `INSERT INTO options (key, value, updated_at)
		VALUES ($1,$2, now())
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, key, value)
	return err
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
