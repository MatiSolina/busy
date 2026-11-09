-- Durable transport identity and bounded replacement-session recovery.
-- These tables are hub-internal. Transport identity is separate from user
-- messages because Live wake requests also need durable delivery records.

CREATE TABLE IF NOT EXISTS public.message_delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  operation_id text NOT NULL UNIQUE,
  posting_token text,
  posting_until timestamptz,
  seeded_text text,
  seeded_client_context jsonb,
  session_id text,
  delivery_id text,
  state text NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'sending', 'accepted', 'failed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS message_delivery_attempt_bot_idx
  ON public.message_delivery_attempts (bot_id, updated_at);

CREATE TABLE IF NOT EXISTS public.session_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  operation_id text NOT NULL UNIQUE,
  source_session_id text,
  reserved_session_id text,
  packet jsonb NOT NULL,
  plan_snapshot jsonb,
  state text NOT NULL DEFAULT 'prepared'
    CHECK (state IN ('prepared', 'creating', 'active', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS session_recovery_active_bot_idx
  ON public.session_recoveries (bot_id)
  WHERE state IN ('prepared', 'creating', 'active');

CREATE INDEX IF NOT EXISTS session_recovery_bot_created_idx
  ON public.session_recoveries (bot_id, created_at);

ALTER TABLE public.message_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_recoveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.message_delivery_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.session_recoveries FROM PUBLIC, anon, authenticated;
