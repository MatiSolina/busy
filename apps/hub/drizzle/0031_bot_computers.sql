-- The bot's computer as the hub coordinates it (lib/live.ts, H-16/H-17/H-18). Matches `botComputers`
-- in lib/db/schema.ts. Additive: a new table, no change to `bots`; a missing row means generation 0,
-- no claim, no login hold and no reported sandbox name (the derived name is the fallback).
--   - generation: every Live heartbeat / chat keep-on / login hold advances it; a shutdown claim
--     taken at one generation can't commit at another.
--   - claim*: one shutdown at a time, tied to the session it stops. `checking` while the watcher or
--     the bot's suspend hook verifies, `stopping` once committed (opening Live waits for it).
--     A claim older than the code's stale window can be taken over (a holder that died).
--   - hold*: request_login keeps the computer alive until hold_until (bounded by the code).
--   - sandbox*: the sandbox name the bot reported for its current session.
-- Apply before deploying the hub code that reads it:
--   psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0031_bot_computers.sql
CREATE TABLE IF NOT EXISTS public.bot_computers (
  bot_id uuid PRIMARY KEY CONSTRAINT bot_computers_bot_id_bots_id_fk REFERENCES public.bots(id) ON DELETE CASCADE,
  generation integer NOT NULL DEFAULT 0,
  claim uuid,
  claim_session_id text,
  claim_phase text,
  claim_at timestamptz,
  hold_session_id text,
  hold_until timestamptz,
  sandbox_session_id text,
  sandbox_name text,
  sandbox_reported_at timestamptz,
  CONSTRAINT bot_computers_claim_phase_check
    CHECK (claim_phase IS NULL OR claim_phase IN ('checking', 'stopping')),
  CONSTRAINT bot_computers_claim_shape_check
    CHECK (
      (claim IS NULL AND claim_session_id IS NULL AND claim_phase IS NULL AND claim_at IS NULL)
      OR (claim IS NOT NULL AND claim_session_id IS NOT NULL AND claim_phase IS NOT NULL AND claim_at IS NOT NULL)
    ),
  CONSTRAINT bot_computers_hold_shape_check
    CHECK ((hold_session_id IS NULL) = (hold_until IS NULL)),
  CONSTRAINT bot_computers_sandbox_shape_check
    CHECK (
      (sandbox_session_id IS NULL AND sandbox_name IS NULL AND sandbox_reported_at IS NULL)
      OR (sandbox_session_id IS NOT NULL AND sandbox_name IS NOT NULL AND sandbox_reported_at IS NOT NULL)
    )
);
ALTER TABLE public.bot_computers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_computers FROM PUBLIC, anon, authenticated;
