-- Durable bot deletion, bot-owned references and upload reservation deadlines
-- (state-machine audit H-09/H-10/H-11/H-37/N-06; docs/library-content.md).
--
-- Additive and safe to re-run. Apply before deploying the hub code that reads
-- these columns. Nothing here deletes rows: legacy orphans are reported with a
-- NOTICE and their foreign key stays NOT VALID (enforced for new writes only)
-- until they are cleaned up with the reviewed queries in docs/library-content.md
-- and this file is applied again, which then validates it.
--
--   psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0029_bot_deletion_files.sql

-- 1. Upload reservations get an explicit deadline (H-37). A pending row past
--    it can no longer complete and is swept with its Blob. 60 minutes = the
--    15-minute signed PUT URL plus a 45-minute grace for a slow upload.
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS pending_until timestamptz;

UPDATE public.files
SET pending_until = created_at + interval '60 minutes'
WHERE status = 'pending' AND pending_until IS NULL;

CREATE INDEX IF NOT EXISTS files_pending_until_idx
  ON public.files (pending_until)
  WHERE status = 'pending';

-- 2. Deletion is a durable phase of the live bot row (H-11). While
--    deletion_state is set the row keeps its slug reserved and refuses new
--    uploads; a workflow (re)started from the row finishes the external
--    effects and then hard-deletes it.
ALTER TABLE public.bots
  ADD COLUMN IF NOT EXISTS deletion_state text,
  ADD COLUMN IF NOT EXISTS deletion_token uuid,
  ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deletion_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS deletion_last_error text,
  ADD COLUMN IF NOT EXISTS deletion_project_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'bots_deletion_state_check'
      AND conrelid = 'public.bots'::regclass
  ) THEN
    ALTER TABLE public.bots
      ADD CONSTRAINT bots_deletion_state_check CHECK (
        (deletion_state IS NULL AND deletion_token IS NULL)
        OR (
          deletion_state IN ('deleting', 'attention')
          AND deletion_token IS NOT NULL
          AND deletion_requested_at IS NOT NULL
        )
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.bots VALIDATE CONSTRAINT bots_deletion_state_check;

CREATE INDEX IF NOT EXISTS bots_deletion_due_idx
  ON public.bots (deletion_next_attempt_at)
  WHERE deletion_state IS NOT NULL;

-- 3. A separate tombstone written right before the hard delete. It never
--    shares the bots.slug unique constraint, so a new bot may reuse the slug,
--    while late callbacks/tokens of the old id or Vercel project can still be
--    recognized and rejected.
CREATE TABLE IF NOT EXISTS public.bot_tombstones (
  bot_id uuid PRIMARY KEY,
  slug text NOT NULL,
  vercel_project_id text,
  bot_created_at timestamptz NOT NULL,
  deletion_requested_at timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_tombstones_slug_idx
  ON public.bot_tombstones (slug);
CREATE INDEX IF NOT EXISTS bot_tombstones_project_idx
  ON public.bot_tombstones (vercel_project_id)
  WHERE vercel_project_id IS NOT NULL;
ALTER TABLE public.bot_tombstones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.bot_tombstones FROM PUBLIC, anon, authenticated;

-- 4. Bot references (H-10). Data the bot owns cascades with its row, exactly
--    what the manual delete did. A consultation another bot opened towards the
--    deleted bot belongs to the asker: its receiver becomes NULL ("otro bot")
--    instead of being deleted.
--
--    A receiver that no longer exists is already shown as "otro bot"; NULL is
--    the same reading, so that is the only backfill.
UPDATE public.consultations c
SET to_bot_id = NULL
WHERE to_bot_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.bots b WHERE b.id = c.to_bot_id);

DO $$
DECLARE
  fk record;
  orphans bigint;
BEGIN
  FOR fk IN
    SELECT * FROM (VALUES
      ('events', 'events_bot_id_bots_id_fk', 'bot_id', 'id', 'CASCADE'),
      ('cursors', 'cursors_bot_id_bots_id_fk', 'bot_id', 'id', 'CASCADE'),
      ('messages', 'messages_bot_id_bots_id_fk', 'bot_id', 'id', 'CASCADE'),
      ('files', 'files_bot_id_bots_id_fk', 'bot_id', 'id', 'CASCADE'),
      ('memories', 'memories_bot_slug_bots_slug_fk', 'bot_slug', 'slug', 'CASCADE'),
      ('consultations', 'consultations_from_bot_id_bots_id_fk', 'from_bot_id', 'id', 'CASCADE'),
      ('consultations', 'consultations_to_bot_id_bots_id_fk', 'to_bot_id', 'id', 'SET NULL')
    ) AS t(tbl, name, col, ref, action)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = fk.name
        AND conrelid = format('public.%I', fk.tbl)::regclass
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.bots(%I) ON DELETE %s NOT VALID',
        fk.tbl, fk.name, fk.col, fk.ref, fk.action
      );
    END IF;

    EXECUTE format(
      'SELECT count(*) FROM public.%I t WHERE t.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.bots b WHERE b.%I = t.%I)',
      fk.tbl, fk.col, fk.ref, fk.col
    ) INTO orphans;

    IF orphans = 0 THEN
      EXECUTE format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I', fk.tbl, fk.name);
    ELSE
      RAISE NOTICE 'bot reference orphans kept in quarantine: %.% = % rows (% stays NOT VALID)',
        fk.tbl, fk.col, orphans, fk.name;
    END IF;
  END LOOP;
END $$;
