-- Schema/migration parity (H-27) and the remaining state CHECKs (H-29).
-- Additive and safe to re-run. Matches lib/db/schema.ts and the lists in
-- lib/db/status-values.ts. Run the read-only preflight in docs/code-quality.md
-- first; this file stops, without changing any row, if one is out of range.
--   psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f apps/hub/drizzle/0025_state_checks.sql
--
-- To add a state later, write a new migration that runs
--   ALTER TABLE <t> DROP CONSTRAINT IF EXISTS <name>;
--   ALTER TABLE <t> ADD CONSTRAINT <name> CHECK (...) NOT VALID;
--   ALTER TABLE <t> VALIDATE CONSTRAINT <name>;
-- and update the list in lib/db/status-values.ts in the same change.

-- Installations that never applied 0020_message_skill_snapshots.sql.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS selected_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS client_context jsonb,
  ADD COLUMN IF NOT EXISTS payload_hash text;
CREATE INDEX IF NOT EXISTS messages_payload_hash_idx
  ON public.messages (bot_id, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- Adds a named CHECK unless it already exists with the same definition:
-- 1. stops if any row violates it (nothing is rewritten);
-- 2. stops if a constraint with that name enforces something else;
-- 3. adds it NOT VALID (brief lock, no scan) and then VALIDATEs it, which
--    scans without blocking reads or writes. A NOT VALID leftover from an
--    interrupted run is validated.
-- pg_temp keeps the helper out of the schema; it disappears with the session.
CREATE OR REPLACE FUNCTION pg_temp.busy_ensure_check(
  target regclass,
  constraint_name text,
  expression text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  existing_definition text;
  existing_valid boolean;
  expected_definition text;
  invalid_rows bigint;
BEGIN
  -- Normalize the expected definition the way PostgreSQL prints it.
  DROP TABLE IF EXISTS pg_temp.busy_check_probe;
  EXECUTE format('CREATE TEMP TABLE busy_check_probe (LIKE %s)', target);
  EXECUTE format(
    'ALTER TABLE pg_temp.busy_check_probe ADD CONSTRAINT %I CHECK (%s)',
    constraint_name,
    expression
  );
  SELECT pg_get_constraintdef(c.oid) INTO expected_definition
  FROM pg_constraint AS c
  WHERE c.conrelid = 'pg_temp.busy_check_probe'::regclass
    AND c.conname = constraint_name;
  DROP TABLE pg_temp.busy_check_probe;

  SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO existing_definition, existing_valid
  FROM pg_constraint AS c
  WHERE c.conrelid = target AND c.conname = constraint_name;

  IF existing_definition IS NOT NULL
     AND replace(existing_definition, ' NOT VALID', '') <> expected_definition THEN
    RAISE EXCEPTION
      '% on % already exists as "%", expected "%"; resolve it by hand',
      constraint_name, target, existing_definition, expected_definition;
  END IF;
  IF existing_definition IS NOT NULL AND existing_valid THEN
    RETURN;
  END IF;

  EXECUTE format('SELECT count(*) FROM %s WHERE (%s) IS FALSE', target, expression)
    INTO invalid_rows;
  IF invalid_rows > 0 THEN
    RAISE EXCEPTION
      '% on %: % existing row(s) are outside the allowed values; run the preflight and decide each row before migrating',
      constraint_name, target, invalid_rows;
  END IF;

  IF existing_definition IS NULL THEN
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s) NOT VALID',
      target, constraint_name, expression
    );
  END IF;
  EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', target, constraint_name);
END
$$;

-- H-27: the 0020 checks, for installations that never applied it.
SELECT pg_temp.busy_ensure_check(
  'public.messages', 'messages_selected_skills_array_check',
  $$jsonb_typeof(selected_skills) = 'array'$$
);
SELECT pg_temp.busy_ensure_check(
  'public.messages', 'messages_payload_hash_check',
  $$payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'$$
);

-- H-29: columns that had no CHECK.
SELECT pg_temp.busy_ensure_check(
  'public.bots', 'bots_billing_check',
  $$billing IN ('token-pass', 'gateway', 'chatgpt', 'grok')$$
);
SELECT pg_temp.busy_ensure_check(
  'public.files', 'files_status_check',
  $$status IN ('pending', 'ready', 'blocked')$$
);
SELECT pg_temp.busy_ensure_check(
  'public.consultations', 'consultations_status_check',
  $$status IN ('open', 'done', 'synced')$$
);

DROP FUNCTION pg_temp.busy_ensure_check(regclass, text, text);
