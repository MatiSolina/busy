-- Content-addressed file objects are separate from per-bot file references.
-- Existing files remain valid with object_id NULL and are hashed lazily on their
-- next verified completion/read; this migration never guesses a digest from a
-- browser-provided value.
CREATE TABLE IF NOT EXISTS public.library_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  pathname text NOT NULL UNIQUE,
  content_type text NOT NULL,
  size integer NOT NULL CHECK (size >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sha256)
);

ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS object_id uuid REFERENCES public.library_objects(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS message_id uuid,
  ADD COLUMN IF NOT EXISTS session_id text,
  ADD COLUMN IF NOT EXISTS turn_id text;

CREATE INDEX IF NOT EXISTS library_objects_status_idx
  ON public.library_objects (status, created_at);
CREATE INDEX IF NOT EXISTS files_object_id_idx
  ON public.files (object_id);
CREATE INDEX IF NOT EXISTS files_provenance_idx
  ON public.files (bot_id, session_id, turn_id, message_id);

ALTER TABLE public.library_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.library_objects FROM PUBLIC, anon, authenticated;

-- The hub's server-side connection owns these writes. The browser and bot
-- routes continue to use the existing session/bot gates, so no Data API grant
-- is added here.
