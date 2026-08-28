-- Per-channel thinking-level vocabulary: "max" = "xhigh" rewrites the level a
-- caller asked for into the one this upstream actually accepts. Empty by
-- default, so existing channels keep forwarding the level verbatim.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS reasoning_effort_mapping JSONB NOT NULL DEFAULT '{}';
