-- A cancelled call is no longer a failure anywhere: not in the error filter,
-- not in the dashboard's counts, not in the hourly rollup behind the heatmap.
--
-- First the rows 0034 marked too eagerly. Before that release, two other
-- endings were logged in the same words as a caller hanging up, "stream
-- interrupted: context canceled": the idle watchdog stopping a stalled stream,
-- and a client hanging up on an error the upstream had already sent. Two kinds
-- of row keep the failure they were:
--   * a status of 400 or more, short of 499: the upstream had answered with an
--     error (a rate limit sent inside a stream is logged as 429);
--   * a stream that ran the watchdog's 120 seconds (the default
--     STREAM_IDLE_TIMEOUT) past its first byte and never got its closing
--     usage: it may have stalled, and nothing shows the answer arrived.
-- Rows written since 0034 are left alone: that release tells these apart.
UPDATE request_logs SET cancelled = false
WHERE cancelled
  AND error = 'stream interrupted: context canceled'
  AND created_at < (SELECT applied_at FROM schema_migrations WHERE version = 34)
  AND ((status_code >= 400 AND status_code <> 499)
       OR (duration_ms - ttfb_ms >= 120000 AND completion_tokens = 0));

-- Then the rollup, which counted every cancelled row as an error. Subtracted
-- rather than recounted: an hour whose log rows were purged keeps what it had,
-- less the cancelled rows that are still here to be seen.
UPDATE usage_hourly u SET errors = greatest(u.errors - c.n, 0)
FROM (SELECT user_id, date_trunc('hour', created_at) AS hour, count(*) AS n
      FROM request_logs
      WHERE cancelled AND (status_code >= 400 OR error <> '')
      GROUP BY 1, 2) c
WHERE u.user_id = c.user_id AND u.hour = c.hour;
