-- Thinking-level rules become per-model. The column keeps its name and its
-- type; only the shape inside changes, from one flat table of renames to one
-- table per model selector:
--
--   before  {"max": "xhigh"}
--   after   {"*": {"max": "xhigh"}}
--
-- The "*" selector is every model the channel serves, so wrapping the existing
-- rules in it preserves exactly what they did before. A selector may also be a
-- model name ("gpt-5.1") or a prefix ("gpt-5*"), matched most-specific first.
--
-- Idempotent by shape rather than by a version marker: a row is old exactly
-- when one of its values is still a bare string, so a re-run after a manual
-- edit converges and an already-migrated row is left alone.
UPDATE channels
SET reasoning_effort_mapping = jsonb_build_object('*', reasoning_effort_mapping)
WHERE reasoning_effort_mapping <> '{}'::jsonb
  AND EXISTS (
      SELECT 1
      FROM jsonb_each(reasoning_effort_mapping) AS entry(key, value)
      WHERE jsonb_typeof(entry.value) = 'string'
  );
