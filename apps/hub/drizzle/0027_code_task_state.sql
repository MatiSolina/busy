-- Code-task state machine hardening (H-25, N-03).
--
-- Read-only preflight (run before applying; counts rows the backfill fixes):
--   SELECT status, finished_at IS NULL AS finished_at_null, count(*)
--     FROM public.code_tasks GROUP BY 1, 2 ORDER BY 1, 2;
--   SELECT count(*) AS terminal_without_finish FROM public.code_tasks
--     WHERE status IN ('ready', 'failed', 'needs_attention', 'cancelled') AND finished_at IS NULL;
--   SELECT count(*) AS active_with_finish FROM public.code_tasks
--     WHERE status IN ('queued', 'running', 'waiting_for_input', 'cancel_requested') AND finished_at IS NOT NULL;
--
-- Apply after the application code that writes status only through
-- transitionTask is deployed, and before code that reads
-- code_task_bot_shutdowns.

-- A bot whose deletion has started admits no new code tasks or instructions.
-- The row disappears with the bot; tasks keep their history with bot_id NULL
-- and the store rejects every non-cancel command for them.
-- The FK carries Drizzle's constraint name so schema drift checks match.
CREATE TABLE IF NOT EXISTS public.code_task_bot_shutdowns (
  bot_id uuid PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT code_task_bot_shutdowns_bot_id_bots_id_fk
    FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE
);
ALTER TABLE public.code_task_bot_shutdowns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.code_task_bot_shutdowns FROM PUBLIC, anon, authenticated;

-- Backfill the terminal <=> finished_at invariant. A terminal row without a
-- finish time takes its last update; an active row (revived by the H-14 bug
-- or cancelled from ready) loses a finish time that no longer applies. No
-- row is deleted.
UPDATE public.code_tasks
  SET finished_at = updated_at
  WHERE status IN ('ready', 'failed', 'needs_attention', 'cancelled')
    AND finished_at IS NULL;
UPDATE public.code_tasks
  SET finished_at = NULL
  WHERE status IN ('queued', 'running', 'waiting_for_input', 'cancel_requested')
    AND finished_at IS NOT NULL;

ALTER TABLE public.code_tasks DROP CONSTRAINT IF EXISTS code_tasks_finished_at_check;
ALTER TABLE public.code_tasks ADD CONSTRAINT code_tasks_finished_at_check
  CHECK ((status IN ('ready', 'failed', 'needs_attention', 'cancelled')) = (finished_at IS NOT NULL))
  NOT VALID;
ALTER TABLE public.code_tasks VALIDATE CONSTRAINT code_tasks_finished_at_check;
