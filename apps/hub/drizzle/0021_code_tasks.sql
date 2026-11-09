-- Durable remote coding tasks. All access is through the hub's server
-- connection; browser roles receive no privileges.
CREATE TABLE IF NOT EXISTS public.code_repositories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid REFERENCES public.mcp_connections(id) ON DELETE SET NULL,
  github_id text NOT NULL,
  full_name text NOT NULL CHECK (full_name ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?/[A-Za-z0-9._-]+$'),
  default_branch text NOT NULL CHECK (length(btrim(default_branch)) BETWEEN 1 AND 255),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS code_repositories_github_id_idx ON public.code_repositories (github_id);
CREATE UNIQUE INDEX IF NOT EXISTS code_repositories_full_name_idx ON public.code_repositories (lower(full_name));
CREATE INDEX IF NOT EXISTS code_repositories_enabled_idx ON public.code_repositories (enabled);

CREATE TABLE IF NOT EXISTS public.code_repository_access (
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES public.code_repositories(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, repository_id)
);
CREATE INDEX IF NOT EXISTS code_repository_access_repository_idx ON public.code_repository_access (repository_id);

CREATE TABLE IF NOT EXISTS public.code_bot_contexts (
  bot_id uuid PRIMARY KEY REFERENCES public.bots(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES public.code_repositories(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.code_tasks (
  id uuid PRIMARY KEY,
  bot_id uuid REFERENCES public.bots(id) ON DELETE SET NULL,
  source_session_id text NOT NULL,
  source_call_id text NOT NULL,
  source_message_id text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  goal text NOT NULL CHECK (length(btrim(goal)) BETWEEN 1 AND 20000),
  repository_id uuid REFERENCES public.code_repositories(id) ON DELETE SET NULL,
  repository_snapshot_id text NOT NULL,
  repository_full_name text NOT NULL,
  base_branch text NOT NULL,
  billing text NOT NULL CHECK (billing IN ('token-pass', 'gateway', 'chatgpt', 'grok')),
  model text NOT NULL,
  fast boolean NOT NULL DEFAULT false,
  agent_name text,
  durable_session_id text,
  branch text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting_for_input', 'ready', 'cancel_requested', 'cancelled', 'failed', 'needs_attention')),
  phase text CHECK (phase IS NULL OR phase IN ('preparing', 'inspecting', 'editing', 'checking', 'publishing', 'waiting', 'recovering')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  instruction_version integer NOT NULL DEFAULT 1 CHECK (instruction_version >= 1),
  applied_instruction_version integer NOT NULL DEFAULT 0 CHECK (applied_instruction_version >= 0),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  commit_sha text,
  pull_request_url text,
  summary text,
  error text,
  execution jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_stream_cursor integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT code_tasks_origin_unique UNIQUE (bot_id, source_session_id, source_call_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS code_tasks_branch_active_idx
  ON public.code_tasks (repository_full_name, branch)
  WHERE status IN ('queued', 'running', 'waiting_for_input', 'cancel_requested') AND branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS code_tasks_bot_created_idx ON public.code_tasks (bot_id, created_at);
CREATE INDEX IF NOT EXISTS code_tasks_status_idx ON public.code_tasks (status, updated_at);

CREATE TABLE IF NOT EXISTS public.code_task_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES public.code_tasks(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('start', 'steer', 'cancel')),
  text text,
  revision integer NOT NULL CHECK (revision > 0),
  instruction_version integer NOT NULL CHECK (instruction_version >= 0),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  message_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'leased', 'accepted', 'applied', 'settled', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_token uuid,
  lease_until timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz,
  finished_at timestamptz,
  CONSTRAINT code_task_commands_message_unique UNIQUE (task_id, message_id)
);
CREATE INDEX IF NOT EXISTS code_task_commands_claim_idx ON public.code_task_commands (status, lease_until, created_at);
CREATE INDEX IF NOT EXISTS code_task_commands_task_idx ON public.code_task_commands (task_id, created_at);

CREATE TABLE IF NOT EXISTS public.code_task_events (
  task_id uuid NOT NULL REFERENCES public.code_tasks(id) ON DELETE CASCADE,
  seq integer NOT NULL CHECK (seq > 0),
  revision integer NOT NULL CHECK (revision > 0),
  source_key text NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, seq),
  CONSTRAINT code_task_events_source_unique UNIQUE (task_id, source_key)
);
CREATE INDEX IF NOT EXISTS code_task_events_task_idx ON public.code_task_events (task_id, created_at);

ALTER TABLE public.code_repositories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_repository_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_bot_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_task_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_task_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.code_repositories, public.code_repository_access, public.code_bot_contexts, public.code_tasks, public.code_task_commands, public.code_task_events FROM PUBLIC, anon, authenticated;
