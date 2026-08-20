-- Channel keepalive: some upstream accounts are reclaimed or throttled when
-- they see no traffic for a while, so a channel can be opened on a daily
-- schedule and closed again once it has served enough successful requests.
--
-- Configuration is keepalive_enabled / keepalive_at / keepalive_target; the
-- rest is the state of the window currently running. keepalive_open and
-- keepalive_opened_at are deliberately separate: closing clears the first and
-- keeps the second, which is what stops the scheduler from seeing "no open
-- window" a minute later and reopening the channel for the same day.
--
-- No matching columns on abilities / ability_prefixes (unlike rpm_limit in
-- 0015): the relay hot path never reads these, and the counting happens in
-- RecordChannelResult, which already writes to channels on every request.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS keepalive_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
    -- "HH:MM", read in the server's local zone (TZ in docker-compose).
    ADD COLUMN IF NOT EXISTS keepalive_at        TEXT    NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS keepalive_target    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS keepalive_open      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS keepalive_success   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS keepalive_opened_at TIMESTAMPTZ;
