-- Bodies stored as content-defined chunks, each kept once. A coding agent
-- resends its whole conversation every turn, so consecutive bodies share
-- nearly all their bytes; measured on the bodies held before this migration,
-- 2.5 GB came down to 54 MB.
--
-- The stored bodies are dropped, not converted: they are a rolling diagnostic
-- window, and refilling it costs nothing but traffic.
DROP TABLE request_log_details;

-- One row per distinct chunk, named by the SHA-256 of its bytes. No foreign
-- key: a chunk is shared by many bodies, and the one that drops it last is not
-- known when it goes. store.CollectChunks removes the ones nothing points at.
CREATE TABLE body_chunks (
    hash      BYTEA       PRIMARY KEY,
    -- gzip of the chunk, in the order chunk.Pack wrote it.
    data      BYTEA       NOT NULL,
    -- Bumped by a writer that reuses a chunk gone stale, which is what keeps
    -- the collector off a chunk a writer is about to point at.
    last_used TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Already compressed: a second pass by pglz costs CPU and saves nothing.
ALTER TABLE body_chunks ALTER COLUMN data SET STORAGE EXTERNAL;

CREATE TABLE request_log_details (
    log_id             BIGINT      PRIMARY KEY
                                   REFERENCES request_logs (id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    request_headers    JSONB       NOT NULL DEFAULT '{}',
    -- The body is these chunks, concatenated in order.
    request_chunks     BYTEA[]     NOT NULL DEFAULT '{}',
    request_truncated  BOOLEAN     NOT NULL DEFAULT FALSE,
    response_headers   JSONB       NOT NULL DEFAULT '{}',
    response_chunks    BYTEA[]     NOT NULL DEFAULT '{}',
    response_truncated BOOLEAN     NOT NULL DEFAULT FALSE
);
