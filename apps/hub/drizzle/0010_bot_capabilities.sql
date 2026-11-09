CREATE TABLE IF NOT EXISTS public.bot_capabilities (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "bot_id" uuid NOT NULL REFERENCES public.bots("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('skill', 'plugin')),
  "name" text NOT NULL,
  "description" text NOT NULL,
  "version" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "skills" jsonb NOT NULL,
  "origin" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("bot_id", "kind", "name")
);

ALTER TABLE public.bot_capabilities ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_capabilities FROM anon, authenticated;
