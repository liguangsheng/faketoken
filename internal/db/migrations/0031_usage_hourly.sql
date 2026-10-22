-- Per-user usage by UTC hour, for the dashboard heatmap. Written alongside
-- each log row and never purged with them, so a log cleanup leaves the
-- history intact. Hours rather than days so any viewer's time zone can be
-- rebuilt from it.
CREATE TABLE IF NOT EXISTS usage_hourly (
    user_id      BIGINT      NOT NULL,
    hour         TIMESTAMPTZ NOT NULL,
    requests     BIGINT      NOT NULL DEFAULT 0,
    errors       BIGINT      NOT NULL DEFAULT 0,
    cost         BIGINT      NOT NULL DEFAULT 0,
    total_tokens BIGINT      NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_hour ON usage_hourly (hour);

-- Seeded from the logs still on hand; the migration and the server's first
-- write cannot overlap, because migrations finish before it serves.
INSERT INTO usage_hourly (user_id, hour, requests, errors, cost, total_tokens)
SELECT user_id, date_trunc('hour', created_at),
       count(*),
       count(*) FILTER (WHERE status_code >= 400 OR error <> ''),
       coalesce(sum(cost), 0),
       coalesce(sum(total_tokens), 0)
FROM request_logs
GROUP BY 1, 2
ON CONFLICT (user_id, hour) DO NOTHING;
