-- Memory provenance for the existing eve fileMemory document.
-- The document remains the source of truth in `memories`; these tables only
-- index current entry metadata and retain an append-only source trail.
CREATE TABLE IF NOT EXISTS public.memory_metadata (
  bot_slug text NOT NULL REFERENCES public.bots(slug) ON DELETE CASCADE,
  entry_id text NOT NULL CHECK (entry_id ~ '^[0-9]+$'),
  text text NOT NULL,
  origin text NOT NULL CHECK (origin IN ('bot', 'legacy', 'owner')),
  source_status text NOT NULL CHECK (
    source_status IN (
      'bot_identity_only',
      'legacy',
      'trusted_eve_turn',
      'trusted_user',
      'unavailable'
    )
  ),
  author text,
  message_id text,
  session_id text,
  turn_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_slug, entry_id)
);

CREATE INDEX IF NOT EXISTS memory_metadata_bot_updated_idx
  ON public.memory_metadata (bot_slug, updated_at DESC, entry_id DESC);

CREATE TABLE IF NOT EXISTS public.memory_metadata_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_slug text NOT NULL REFERENCES public.bots(slug) ON DELETE CASCADE,
  entry_id text NOT NULL CHECK (entry_id ~ '^[0-9]+$'),
  document_version integer NOT NULL CHECK (document_version > 0),
  action text NOT NULL CHECK (action IN ('added', 'attributed', 'removed', 'updated')),
  before_text text,
  after_text text,
  origin text NOT NULL CHECK (origin IN ('bot', 'legacy', 'owner')),
  source_status text NOT NULL CHECK (
    source_status IN (
      'bot_identity_only',
      'legacy',
      'trusted_eve_turn',
      'trusted_user',
      'unavailable'
    )
  ),
  author text,
  message_id text,
  session_id text,
  turn_id text,
  change_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_slug, change_key)
);

CREATE INDEX IF NOT EXISTS memory_metadata_events_bot_entry_idx
  ON public.memory_metadata_events (bot_slug, entry_id, created_at ASC);

ALTER TABLE public.memory_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.memory_metadata_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.memory_metadata, public.memory_metadata_events
  FROM PUBLIC, anon, authenticated;
