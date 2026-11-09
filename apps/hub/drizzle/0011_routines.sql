CREATE TABLE IF NOT EXISTS public.routines (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 20000),
  time text NOT NULL CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text NOT NULL,
  days_of_week jsonb NOT NULL CHECK (jsonb_typeof(days_of_week) = 'array' AND jsonb_array_length(days_of_week) BETWEEN 1 AND 7),
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS routines_due_idx ON public.routines (enabled, next_run_at);
CREATE INDEX IF NOT EXISTS routines_bot_idx ON public.routines (bot_id, created_at);

CREATE TABLE IF NOT EXISTS public.routine_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  routine_id uuid NOT NULL REFERENCES public.routines(id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  scheduled_for timestamptz NOT NULL,
  prompt text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'succeeded', 'failed', 'cancelled')),
  session_id text,
  delivery_id text,
  lease_token uuid,
  lease_until timestamptz,
  retry_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routine_runs_occurrence_unique UNIQUE (routine_id, scheduled_for)
);
CREATE INDEX IF NOT EXISTS routine_runs_pending_idx ON public.routine_runs (status, retry_at);
CREATE INDEX IF NOT EXISTS routine_runs_bot_idx ON public.routine_runs (bot_id);
CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_one_active_idx ON public.routine_runs (routine_id)
  WHERE status IN ('pending', 'dispatched');

ALTER TABLE public.routines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.routine_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.routines, public.routine_runs FROM anon, authenticated;
