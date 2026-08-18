-- Request protocol is derived from the endpoint, so a channel no longer has
-- one fixed provider type. auth_style is only an escape hatch for upstreams
-- whose credential header differs from the protocol default.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS auth_style TEXT NOT NULL DEFAULT 'auto';

ALTER TABLE channels
    DROP COLUMN IF EXISTS type;
