-- One durable runner per fireside (H-32). Commands, answers, creation and the cron only wake this
-- row; a workflow is started only by whoever acquires it (idle or lease expired) and then claims
-- the start. The workflow heartbeats with its run_id; a runner that loses the row stops mutating.
-- Additive: existing firesides get a row the first time something wakes them.
CREATE TABLE IF NOT EXISTS public.fireside_runners (
  fireside_id uuid PRIMARY KEY CONSTRAINT fireside_runners_fireside_id_firesides_id_fk REFERENCES public.firesides(id) ON DELETE CASCADE,
  run_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 1,
  status text NOT NULL CHECK (status IN ('starting', 'active', 'idle')),
  wakes integer NOT NULL DEFAULT 0,
  heartbeat_at timestamptz,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  workflow_run_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fireside_runners_status_lease_idx
  ON public.fireside_runners (status, lease_until);
ALTER TABLE public.fireside_runners ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.fireside_runners FROM PUBLIC, anon, authenticated;
