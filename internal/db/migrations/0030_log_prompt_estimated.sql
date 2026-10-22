-- Set when the upstream reported zero input tokens and the count was
-- estimated from the request body instead.
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS prompt_estimated BOOLEAN NOT NULL DEFAULT false;
