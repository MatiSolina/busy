CREATE TABLE IF NOT EXISTS public.mcp_app_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.mcp_connections(id) ON DELETE CASCADE,
  call_id text NOT NULL,
  session_id text NOT NULL,
  tool_name text NOT NULL,
  sealed_result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mcp_app_results_call_unique UNIQUE (bot_id, session_id, call_id, connection_id)
);

CREATE INDEX IF NOT EXISTS mcp_app_results_session_idx
  ON public.mcp_app_results (bot_id, session_id);

ALTER TABLE public.mcp_app_results ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mcp_app_results FROM PUBLIC, anon, authenticated;
