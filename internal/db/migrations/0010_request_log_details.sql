-- Full request and response bodies for the most recent calls.
--
-- A separate table rather than columns on request_logs: that table is scanned
-- by the listing and by three aggregate queries, and megabyte-sized TEXT
-- columns would drag every one of them down. Keeping the bodies apart also
-- lets the metadata be retained for months while the bodies are capped at a
-- few thousand rows.
CREATE TABLE request_log_details (
    -- Shares the identity of the row it describes, so a purged log takes its
    -- bodies with it and no orphan can survive.
    log_id             BIGINT      PRIMARY KEY
                                   REFERENCES request_logs (id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_headers    JSONB       NOT NULL DEFAULT '{}',
    request_body       TEXT        NOT NULL DEFAULT '',
    request_truncated  BOOLEAN     NOT NULL DEFAULT FALSE,
    response_headers   JSONB       NOT NULL DEFAULT '{}',
    response_body      TEXT        NOT NULL DEFAULT '',
    response_truncated BOOLEAN     NOT NULL DEFAULT FALSE
);
