-- Routine recovery (H-05) and post-commit schedule sync (H-12). Additive and re-runnable; matches
-- `routines`, `routineRuns` and `routineScheduleOutbox` in lib/db/schema.ts. Apply BEFORE deploying
-- the hub code that reads these columns:
--   psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0030_routine_recovery_schedule_outbox.sql
-- Read-only preflight (expected: no rows outside the listed statuses):
--   SELECT status, count(*) FROM routine_runs GROUP BY status;
--   SELECT count(*) AS routines, count(*) FILTER (WHERE deleted_at IS NOT NULL) AS deleted FROM routines;

-- H-05: what the monitor last saw. Subordinate to `status`, which keeps its five public values.
ALTER TABLE public.routine_runs ADD COLUMN IF NOT EXISTS last_observed_at timestamptz;
ALTER TABLE public.routine_runs ADD COLUMN IF NOT EXISTS awaiting_input_at timestamptz;
CREATE INDEX IF NOT EXISTS routine_runs_dispatched_observed_idx
  ON public.routine_runs (last_observed_at)
  WHERE status = 'dispatched';

-- H-05: occurrences not run because the previous one was still active are counted, not hidden.
ALTER TABLE public.routines ADD COLUMN IF NOT EXISTS skipped_occurrences integer NOT NULL DEFAULT 0;
ALTER TABLE public.routines ADD COLUMN IF NOT EXISTS last_skip_reason text;
ALTER TABLE public.routines ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'routines_last_skip_reason_check'
  ) THEN
    ALTER TABLE public.routines
      ADD CONSTRAINT routines_last_skip_reason_check
      CHECK (last_skip_reason IN ('active_run', 'awaiting_input', 'duplicate_occurrence'))
      NOT VALID;
  END IF;
END $$;
ALTER TABLE public.routines VALIDATE CONSTRAINT routines_last_skip_reason_check;

-- H-12: every change to a routine's external schedule bumps its generation in the same transaction.
ALTER TABLE public.routines ADD COLUMN IF NOT EXISTS schedule_generation integer NOT NULL DEFAULT 1;

-- H-12: one durable sync job per routine, written in the routine's own transaction and applied by
-- lib/routines/outbox.ts after commit. No foreign key on purpose: a routine removed with its bot
-- must still leave the job that deletes its Vercel schedule.
CREATE TABLE IF NOT EXISTS public.routine_schedule_outbox (
  routine_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL,
  generation integer NOT NULL,
  action text NOT NULL CHECK (action IN ('upsert', 'disable', 'delete')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routine_schedule_outbox_due_idx
  ON public.routine_schedule_outbox (next_attempt_at)
  WHERE status = 'pending';
ALTER TABLE public.routine_schedule_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.routine_schedule_outbox FROM anon, authenticated;

-- Backfill: re-apply every existing routine's schedule once, which also repairs a schedule that
-- diverged before this change. Deleting a missing schedule counts as done.
INSERT INTO public.routine_schedule_outbox (routine_id, bot_id, generation, action)
SELECT
  id,
  bot_id,
  schedule_generation,
  CASE
    WHEN deleted_at IS NOT NULL THEN 'delete'
    WHEN NOT enabled THEN 'disable'
    ELSE 'upsert'
  END
FROM public.routines
ON CONFLICT (routine_id) DO NOTHING;
