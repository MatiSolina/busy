-- Keep a promoted upload until the short-lived signed URLs issued before
-- promotion have expired. The library verification cron clears these columns
-- and deletes the old Blob path afterward.
ALTER TABLE public.files
  ADD COLUMN IF NOT EXISTS stale_pathname text,
  ADD COLUMN IF NOT EXISTS stale_until timestamptz;

CREATE INDEX IF NOT EXISTS files_stale_until_idx
  ON public.files (stale_until)
  WHERE stale_until IS NOT NULL;
