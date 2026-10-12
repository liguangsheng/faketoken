-- Per-channel status rewrite: {"429": 503} answers the caller with 503 when this
-- channel's upstream says 429. Empty by default, so existing channels keep
-- passing the upstream's code through.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS status_code_mapping JSONB NOT NULL DEFAULT '{}';

-- What the upstream actually answered, kept beside status_code (what the caller
-- was sent) when a channel rule rewrote it. 0 means no rule fired and the two
-- are the same.
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS upstream_status INTEGER NOT NULL DEFAULT 0;
