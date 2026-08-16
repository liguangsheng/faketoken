-- Invitation codes: an administrator hands one out, a visitor spends it to
-- create an account.
--
-- One code, one account. A multi-use code would be fewer rows, but it gives up
-- the thing that makes invitations worth having: knowing which invitation each
-- account came from, and being able to revoke one without touching the rest.
CREATE TABLE IF NOT EXISTS invite_codes (
    id           BIGSERIAL   PRIMARY KEY,
    -- Readable on purpose, like a redemption code: whoever generated it still
    -- has to pass it to a person. It buys an account, not access to one.
    code         TEXT        NOT NULL UNIQUE,
    name         TEXT        NOT NULL DEFAULT '',
    status       SMALLINT    NOT NULL DEFAULT 1,  -- 1 = unused, 2 = used, 3 = disabled
    -- Who signed up with it. SET NULL rather than CASCADE: deleting an account
    -- must not erase the record that an invitation was spent.
    used_by      BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    used_by_name TEXT        NOT NULL DEFAULT '',  -- kept after the account is gone
    used_at      TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invite_codes_status
    ON invite_codes (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invite_codes_used_by ON invite_codes (used_by);
