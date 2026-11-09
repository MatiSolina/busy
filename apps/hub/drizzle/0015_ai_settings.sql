-- Single-account provider preference for the Busy hub.
CREATE TABLE IF NOT EXISTS public.app_ai_settings (
  id text PRIMARY KEY CHECK (id = 'default'),
  provider text CHECK (provider IS NULL OR provider IN ('token-pass', 'gateway')),
  onboarding_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_ai_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_ai_settings FROM PUBLIC, anon, authenticated;
