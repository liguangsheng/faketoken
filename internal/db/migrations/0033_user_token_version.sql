-- A session token carries the version it was issued under, and changing the
-- password bumps it, which ends every older session. Tokens issued before this
-- column existed carry no version, read as 0, and stay valid until then.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
