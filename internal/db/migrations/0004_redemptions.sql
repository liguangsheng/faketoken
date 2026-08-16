-- Redemption codes: prepaid credit an administrator hands out and a user
-- exchanges for balance.

CREATE TABLE IF NOT EXISTS redemptions (
    id         BIGSERIAL PRIMARY KEY,
    -- The code is a bearer credential, but unlike an API key it has to be
    -- readable: the administrator who generated it still needs to distribute
    -- it. Its blast radius is bounded by the quota it carries.
    code       TEXT        NOT NULL UNIQUE,
    name       TEXT        NOT NULL DEFAULT '',
    quota      BIGINT      NOT NULL,              -- micro-USD granted on redeem
    status     SMALLINT    NOT NULL DEFAULT 1,    -- 1 = unused, 2 = used, 3 = disabled
    used_by    BIGINT      REFERENCES users (id) ON DELETE SET NULL,
    used_by_name TEXT      NOT NULL DEFAULT '',   -- kept after the account is gone
    used_at    TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_redemptions_status ON redemptions (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_redemptions_used_by ON redemptions (used_by);
