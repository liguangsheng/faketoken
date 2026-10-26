package store

import (
	"context"
	"log/slog"
	"time"
)

// HealthCount is how a channel fared over one window, counted per attempt.
type HealthCount struct {
	Attempts int64 `json:"attempts"`
	Failures int64 `json:"failures"`
}

// ChannelHealth is a channel's recent record. The lifetime counters on the
// channel row only grow, so a channel that recovered keeps looking broken and
// one that just started failing is lost in its own history; these windows
// answer "is it failing now".
type ChannelHealth struct {
	Hour HealthCount `json:"hour"`
	Day  HealthCount `json:"day"`
}

// countAttempt adds one attempt to the channel's current ten-minute bucket.
// It rides on RecordChannelResult, which already sees every attempt the relay
// makes, retried or final, and none of the console's probes. The failure
// decision is the relay's: a caller hanging up is not one.
func (s *Store) countAttempt(ctx context.Context, id int64, failed bool) {
	failures := 0
	if failed {
		failures = 1
	}
	if _, err := s.pool.Exec(ctx, `INSERT INTO channel_attempts (channel_id, bucket, attempts, failures)
		VALUES ($1, date_bin('10 minutes', now(), TIMESTAMPTZ '2000-01-01'), 1, $2)
		ON CONFLICT (channel_id, bucket) DO UPDATE
		SET attempts = channel_attempts.attempts + 1,
		    failures = channel_attempts.failures + EXCLUDED.failures`, id, failures); err != nil {
		slog.Warn("channel attempt not counted", "channel", id, "error", err)
	}
}

// RecentChannelHealth sums each channel's attempts over the last hour and day,
// to the ten-minute bucket. Channels with no attempts are absent.
func (s *Store) RecentChannelHealth(ctx context.Context, now time.Time) (map[int64]ChannelHealth, error) {
	rows, err := s.pool.Query(ctx, `SELECT channel_id,
			coalesce(sum(attempts) FILTER (WHERE bucket >= $2), 0),
			coalesce(sum(failures) FILTER (WHERE bucket >= $2), 0),
			sum(attempts), sum(failures)
		FROM channel_attempts
		WHERE bucket >= $1
		GROUP BY channel_id`, now.Add(-24*time.Hour), now.Add(-time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[int64]ChannelHealth{}
	for rows.Next() {
		var id int64
		var h ChannelHealth
		if err := rows.Scan(&id, &h.Hour.Attempts, &h.Hour.Failures,
			&h.Day.Attempts, &h.Day.Failures); err != nil {
			return nil, err
		}
		out[id] = h
	}
	return out, rows.Err()
}

// StartAttemptPruner drops attempt buckets older than a week, at every tick.
// The console reads one day; the rest is slack for looking back by hand.
func (s *Store) StartAttemptPruner(ctx context.Context, every time.Duration) {
	go func() {
		ticker := time.NewTicker(every)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if _, err := s.pool.Exec(ctx,
					`DELETE FROM channel_attempts WHERE bucket < now() - interval '7 days'`); err != nil {
					slog.Error("channel attempt pruning failed", "error", err)
				}
			}
		}
	}()
}
