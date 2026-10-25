package store

import (
	"context"
	"time"
)

// HealthCount is how a channel fared over one window.
type HealthCount struct {
	Requests int64 `json:"requests"`
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

// RecentChannelHealth counts each channel's calls over the last hour and day.
// A failure is one the channel may answer for: an error status other than the
// caller hanging up (499), or an error recorded on a call that answered 200,
// short of an operator cancelling it. Channels with no calls are absent.
func (s *Store) RecentChannelHealth(ctx context.Context, now time.Time) (map[int64]ChannelHealth, error) {
	rows, err := s.pool.Query(ctx, `SELECT channel_id,
			count(*) FILTER (WHERE created_at >= $2),
			count(*) FILTER (WHERE created_at >= $2 AND failed),
			count(*),
			count(*) FILTER (WHERE failed)
		FROM (
			SELECT channel_id, created_at,
				(status_code >= 400 AND status_code <> 499)
				OR (status_code < 400 AND error <> '' AND error <> 'cancelled by an administrator') AS failed
			FROM request_logs
			WHERE created_at >= $1 AND channel_id > 0
		) recent
		GROUP BY channel_id`, now.Add(-24*time.Hour), now.Add(-time.Hour))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := map[int64]ChannelHealth{}
	for rows.Next() {
		var id int64
		var h ChannelHealth
		if err := rows.Scan(&id, &h.Hour.Requests, &h.Hour.Failures,
			&h.Day.Requests, &h.Day.Failures); err != nil {
			return nil, err
		}
		out[id] = h
	}
	return out, rows.Err()
}
