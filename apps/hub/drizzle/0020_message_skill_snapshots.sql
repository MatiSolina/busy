-- A message owns the exact skill selection and client context used for its
-- first delivery. Retries with the same UUID can therefore be compared before
-- a resend, even if the shared app catalog has changed in the meantime.
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS selected_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS client_context jsonb,
  ADD COLUMN IF NOT EXISTS payload_hash text;

ALTER TABLE public.messages
  DROP CONSTRAINT IF EXISTS messages_selected_skills_array_check,
  ADD CONSTRAINT messages_selected_skills_array_check
    CHECK (jsonb_typeof(selected_skills) = 'array'),
  DROP CONSTRAINT IF EXISTS messages_payload_hash_check,
  ADD CONSTRAINT messages_payload_hash_check
    CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX IF NOT EXISTS messages_payload_hash_idx
  ON public.messages (bot_id, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- The hub's server-side connection owns these fields. Browser roles retain no
-- direct table access, matching the existing messages table policy.
