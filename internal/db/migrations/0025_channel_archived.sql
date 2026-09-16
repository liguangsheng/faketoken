-- Archiving retires a channel without deleting it: it leaves the main listing
-- and folds into a collapsed section, keeping its history and configuration.
--
-- Archiving always disables, so an archived channel can never quietly keep
-- serving traffic while hidden from view. The flag is separate from status
-- because "retired" and "temporarily off" are different states: unarchiving
-- restores the row to the listing but leaves it disabled, so putting a channel
-- back into rotation stays a deliberate second step.
ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;

-- The listing filters on this on every page load, and an archive is expected to
-- grow while staying a small share of the table.
CREATE INDEX IF NOT EXISTS idx_channels_archived ON channels (archived) WHERE archived;

-- Repair any row that predates the invariant. There are none on a fresh
-- migration; this is here so a re-run after a manual DB edit converges.
-- 2 is model.StatusDisabled.
UPDATE channels SET status = 2 WHERE archived AND status <> 2;
