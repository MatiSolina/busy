CREATE TABLE IF NOT EXISTS public.mcp_provider_clients (
  provider text PRIMARY KEY CHECK (provider IN ('github', 'google')),
  sealed_client text NOT NULL,
  version uuid NOT NULL DEFAULT gen_random_uuid(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.mcp_provider_clients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_provider_clients FROM anon, authenticated;
