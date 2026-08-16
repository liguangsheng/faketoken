-- Two things a log reader keeps asking about but could not see: how hard the
-- model was told to think, and which client sent the request.

-- "" when the caller asked for nothing, which is the common case.
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT '';

-- "unknown" rather than "" so the column reads honestly: we looked and could
-- not tell, which is different from not having looked.
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'unknown';

ALTER TABLE session_logs
    ADD COLUMN IF NOT EXISTS reasoning_effort TEXT NOT NULL DEFAULT '';
ALTER TABLE session_logs
    ADD COLUMN IF NOT EXISTS client_type TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS idx_logs_client_type ON request_logs (client_type, created_at DESC);
