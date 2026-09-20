-- Per-channel retry, on top of the global max_retries. The global setting
-- stays the cap on how many channels one request may visit; these two govern
-- the attempts spent on a single channel before the request moves on.
--
-- retry_count is how many extra attempts the channel gets (0 keeps the old
-- behaviour: one shot per channel). retry_backoff_ms is the base delay between
-- those attempts, 0 meaning "use the global retry interval".
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS retry_count      INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS retry_backoff_ms INTEGER NOT NULL DEFAULT 0;
