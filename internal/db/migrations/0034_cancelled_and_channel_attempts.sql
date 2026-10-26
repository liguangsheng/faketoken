-- cancelled marks a call that ended because its caller hung up or an operator
-- stopped it: not the channel's failure. Older rows are classified by their
-- message. Before this column a stalled upstream ended with the same
-- "context canceled" text a departing caller did, so a few of those are
-- counted as cancelled too.
ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS cancelled BOOLEAN NOT NULL DEFAULT false;
UPDATE request_logs SET cancelled = true
WHERE status_code = 499
   OR error IN ('client closed request', 'cancelled by an administrator',
                'stream interrupted: context canceled');

-- Every attempt's outcome per channel, in ten-minute buckets: the recent-health
-- view the console reads. A request that fails over visits several channels
-- but logs one row, against the last, so the log cannot say how each fared.
CREATE TABLE IF NOT EXISTS channel_attempts (
    channel_id BIGINT      NOT NULL,
    bucket     TIMESTAMPTZ NOT NULL,
    attempts   INTEGER     NOT NULL DEFAULT 0,
    failures   INTEGER     NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, bucket)
);
