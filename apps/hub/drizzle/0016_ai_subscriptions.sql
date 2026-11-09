-- Encrypted OAuth grants and short-lived sign-in attempts for provider plans.
-- Browser roles have no access; only the hub's server connection may read these.
ALTER TABLE public.app_ai_settings
  DROP CONSTRAINT IF EXISTS app_ai_settings_provider_check;
ALTER TABLE public.app_ai_settings
  ADD CONSTRAINT app_ai_settings_provider_check
  CHECK (provider IS NULL OR provider IN ('token-pass', 'gateway', 'chatgpt', 'grok'));
ALTER TABLE public.app_ai_settings
  ADD COLUMN IF NOT EXISTS model text;

CREATE TABLE IF NOT EXISTS public.ai_subscription_hosts (
  id text PRIMARY KEY CHECK (id = 'default'),
  host_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_subscription_connections (
  provider text PRIMARY KEY CHECK (provider IN ('chatgpt', 'grok')),
  sealed_credentials text NOT NULL,
  account_id text,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  connected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_subscription_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('chatgpt', 'grok')),
  "user" text NOT NULL,
  sealed_attempt text NOT NULL,
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_subscription_attempts_user_provider_idx
  ON public.ai_subscription_attempts ("user", provider);

ALTER TABLE public.ai_subscription_hosts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_subscription_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_subscription_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ai_subscription_hosts, public.ai_subscription_connections, public.ai_subscription_attempts FROM PUBLIC, anon, authenticated;
