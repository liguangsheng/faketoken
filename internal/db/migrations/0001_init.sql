-- Core schema for the LLM relay station.

CREATE TABLE IF NOT EXISTS users (
    id            BIGSERIAL PRIMARY KEY,
    username      TEXT        NOT NULL UNIQUE,
    password_hash TEXT        NOT NULL,
    display_name  TEXT        NOT NULL DEFAULT '',
    email         TEXT        NOT NULL DEFAULT '',
    role          SMALLINT    NOT NULL DEFAULT 1,  -- 1 = user, 100 = admin
    status        SMALLINT    NOT NULL DEFAULT 1,  -- 1 = enabled, 2 = disabled
    user_group    TEXT        NOT NULL DEFAULT 'default',
    quota         BIGINT      NOT NULL DEFAULT 0,  -- remaining balance, micro-USD
    used_quota    BIGINT      NOT NULL DEFAULT 0,
    request_count BIGINT      NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_groups (
    name        TEXT             PRIMARY KEY,
    rate        DOUBLE PRECISION NOT NULL DEFAULT 1,  -- price multiplier
    description TEXT             NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ      NOT NULL DEFAULT now()
);

INSERT INTO user_groups (name, rate, description) VALUES ('default', 1, 'Default group')
    ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS tokens (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name            TEXT        NOT NULL DEFAULT '',
    key_hash        TEXT        NOT NULL UNIQUE,  -- sha256 hex of the raw key
    key_prefix      TEXT        NOT NULL DEFAULT '',
    status          SMALLINT    NOT NULL DEFAULT 1,  -- 1 = enabled, 2 = disabled
    unlimited_quota BOOLEAN     NOT NULL DEFAULT TRUE,
    quota           BIGINT      NOT NULL DEFAULT 0,  -- remaining allowance when not unlimited
    used_quota      BIGINT      NOT NULL DEFAULT 0,
    allowed_models  TEXT[]      NOT NULL DEFAULT '{}',  -- empty = every model the group allows
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);

CREATE TABLE IF NOT EXISTS channels (
    id             BIGSERIAL PRIMARY KEY,
    name           TEXT        NOT NULL,
    type           TEXT        NOT NULL DEFAULT 'openai',  -- openai | anthropic | gemini
    base_url       TEXT        NOT NULL DEFAULT '',
    api_key_enc    TEXT        NOT NULL DEFAULT '',        -- AES-GCM encrypted upstream key
    status         SMALLINT    NOT NULL DEFAULT 1,         -- 1 = enabled, 2 = disabled, 3 = auto-disabled
    priority       INTEGER     NOT NULL DEFAULT 0,         -- higher wins
    weight         INTEGER     NOT NULL DEFAULT 1,         -- weighted random within a priority tier
    channel_groups TEXT[]      NOT NULL DEFAULT '{default}',
    models         TEXT[]      NOT NULL DEFAULT '{}',      -- models exposed to clients
    model_mapping  JSONB       NOT NULL DEFAULT '{}',      -- {"client-model": "upstream-model"}
    headers        JSONB       NOT NULL DEFAULT '{}',      -- extra upstream headers
    timeout_secs   INTEGER     NOT NULL DEFAULT 0,         -- 0 = use global default
    proxy_url      TEXT        NOT NULL DEFAULT '',
    price_ratio    DOUBLE PRECISION NOT NULL DEFAULT 1,    -- channel-level cost multiplier
    used_quota     BIGINT      NOT NULL DEFAULT 0,
    request_count  BIGINT      NOT NULL DEFAULT 0,
    error_count    BIGINT      NOT NULL DEFAULT 0,
    last_error     TEXT        NOT NULL DEFAULT '',
    last_error_at  TIMESTAMPTZ,
    tested_at      TIMESTAMPTZ,
    models_synced_at TIMESTAMPTZ,
    note           TEXT        NOT NULL DEFAULT '',
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_channels_status ON channels (status);

-- Denormalised routing table: (group, model) -> channel. Rebuilt whenever a channel changes.
CREATE TABLE IF NOT EXISTS abilities (
    group_name TEXT    NOT NULL,
    model      TEXT    NOT NULL,
    channel_id BIGINT  NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    priority   INTEGER NOT NULL DEFAULT 0,
    weight     INTEGER NOT NULL DEFAULT 1,
    enabled    BOOLEAN NOT NULL DEFAULT TRUE,
    PRIMARY KEY (group_name, model, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_abilities_lookup
    ON abilities (group_name, model, enabled, priority DESC);

-- Raw model catalogue pulled from upstream, kept for reference / one-click import.
CREATE TABLE IF NOT EXISTS channel_models (
    channel_id BIGINT      NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    model      TEXT        NOT NULL,
    raw        JSONB       NOT NULL DEFAULT '{}',
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, model)
);

CREATE TABLE IF NOT EXISTS model_prices (
    model             TEXT             PRIMARY KEY,
    input_price       DOUBLE PRECISION NOT NULL DEFAULT 0,  -- USD per 1M input tokens
    output_price      DOUBLE PRECISION NOT NULL DEFAULT 0,  -- USD per 1M output tokens
    cached_price      DOUBLE PRECISION NOT NULL DEFAULT 0,  -- USD per 1M cached input tokens
    per_request_price DOUBLE PRECISION NOT NULL DEFAULT 0,  -- USD per request, flat
    updated_at        TIMESTAMPTZ      NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS request_logs (
    id                BIGSERIAL PRIMARY KEY,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id           BIGINT      NOT NULL DEFAULT 0,
    username          TEXT        NOT NULL DEFAULT '',
    token_id          BIGINT      NOT NULL DEFAULT 0,
    token_name        TEXT        NOT NULL DEFAULT '',
    channel_id        BIGINT      NOT NULL DEFAULT 0,
    channel_name      TEXT        NOT NULL DEFAULT '',
    model             TEXT        NOT NULL DEFAULT '',
    upstream_model    TEXT        NOT NULL DEFAULT '',
    endpoint          TEXT        NOT NULL DEFAULT '',
    method            TEXT        NOT NULL DEFAULT '',
    status_code       INTEGER     NOT NULL DEFAULT 0,
    stream            BOOLEAN     NOT NULL DEFAULT FALSE,
    prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
    completion_tokens INTEGER     NOT NULL DEFAULT 0,
    cached_tokens     INTEGER     NOT NULL DEFAULT 0,
    total_tokens      INTEGER     NOT NULL DEFAULT 0,
    cost              BIGINT      NOT NULL DEFAULT 0,  -- micro-USD
    duration_ms       INTEGER     NOT NULL DEFAULT 0,
    ttfb_ms           INTEGER     NOT NULL DEFAULT 0,
    retries           INTEGER     NOT NULL DEFAULT 0,
    client_ip         TEXT        NOT NULL DEFAULT '',
    error             TEXT        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_logs_created ON request_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_user ON request_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_channel ON request_logs (channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_model ON request_logs (model, created_at DESC);

CREATE TABLE IF NOT EXISTS options (
    key        TEXT        PRIMARY KEY,
    value      TEXT        NOT NULL DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
