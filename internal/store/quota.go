package store

import "context"

// ConsumeQuota debits a completed request from both the user balance and the
// token allowance in one transaction. Balances are allowed to go negative for
// the last request: usage is only known after the upstream answered, and
// refusing to record it would let callers overspend silently.
func (s *Store) ConsumeQuota(ctx context.Context, userID, tokenID, cost int64) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	if _, err := tx.Exec(ctx, `UPDATE users
		SET quota = quota - $2, used_quota = used_quota + $2, request_count = request_count + 1,
		    updated_at = now()
		WHERE id = $1`, userID, cost); err != nil {
		return err
	}
	if tokenID > 0 {
		if _, err := tx.Exec(ctx, `UPDATE tokens
			SET used_quota = used_quota + $2,
			    quota = CASE WHEN unlimited_quota THEN quota ELSE quota - $2 END,
			    last_used_at = now(), updated_at = now()
			WHERE id = $1`, tokenID, cost); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
