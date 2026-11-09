-- Search indexes for the existing primary chat records. The query layer still
-- filters consultations by their trusted child session ids.
CREATE INDEX IF NOT EXISTS messages_history_fts_idx
  ON public.messages USING gin (to_tsvector('simple', text));

CREATE INDEX IF NOT EXISTS messages_history_bot_created_idx
  ON public.messages (bot_id, created_at DESC);

CREATE INDEX IF NOT EXISTS events_history_reply_fts_idx
  ON public.events USING gin (
    to_tsvector('simple', coalesce(data->'data'->>'value', ''))
  )
  WHERE type = 'content.completed'
    AND data->'data'->>'kind' = 'text'
    AND data->'data'->>'phase' = 'reply';

CREATE INDEX IF NOT EXISTS events_history_bot_created_idx
  ON public.events (bot_id, at DESC)
  WHERE type = 'content.completed';

-- Optional semantic search is opt-in. Vectors are kept as JSON so the feature
-- remains deployable on projects where pgvector is not enabled; the durable
-- workflow stores model/content identity and can be rerun when the model changes.
CREATE TABLE IF NOT EXISTS public.history_embeddings (
  bot_id uuid NOT NULL REFERENCES public.bots(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('message', 'event', 'memory')),
  source_id text NOT NULL,
  session_id text,
  turn_id text,
  text text NOT NULL,
  content_hash text NOT NULL,
  model text NOT NULL,
  embedding jsonb,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, source, source_id, model)
);

CREATE INDEX IF NOT EXISTS history_embeddings_pending_idx
  ON public.history_embeddings (next_attempt_at, updated_at)
  WHERE embedding IS NULL;

CREATE INDEX IF NOT EXISTS history_embeddings_bot_model_idx
  ON public.history_embeddings (bot_id, model, updated_at DESC)
  WHERE embedding IS NOT NULL;

ALTER TABLE public.history_embeddings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.history_embeddings FROM PUBLIC, anon, authenticated;
