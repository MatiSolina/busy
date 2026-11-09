-- Full-agent fireside conversations. Access is exclusively through authenticated hub routes.
CREATE TABLE IF NOT EXISTS public.firesides (
  id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  origin_id uuid NOT NULL UNIQUE,
  parent_session_id text,
  status text NOT NULL CHECK (status IN ('running', 'waiting', 'paused', 'closing', 'closed', 'failed')),
  state jsonb NOT NULL,
  version integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS firesides_bot_created_idx ON public.firesides (bot_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS firesides_active_bot_idx ON public.firesides (bot_id)
  WHERE status IN ('running', 'waiting', 'paused', 'closing');
CREATE TABLE IF NOT EXISTS public.fireside_commands (
  id uuid PRIMARY KEY,
  fireside_id uuid NOT NULL REFERENCES public.firesides(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.firesides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fireside_commands ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.firesides, public.fireside_commands FROM PUBLIC, anon, authenticated;
