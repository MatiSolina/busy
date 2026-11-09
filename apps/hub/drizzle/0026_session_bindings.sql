-- Main-session openings, main-session registry and message delivery bindings
-- (state-machine audit H-02, H-21, H-35, H-36, H-43, N-04, N-06). Additive and idempotent.
--
-- Read-only preflight (run before applying; counts only):
--   SELECT count(*) FILTER (WHERE session_id IS NOT NULL) AS bots_with_session FROM bots;
--   SELECT status, count(*) FROM messages GROUP BY status;
--   SELECT count(*) AS accepted_without_delivery FROM messages
--     WHERE status = 'accepted' AND delivery_id IS NULL;
--   SELECT count(*) AS deliveries_admitted_twice FROM (
--     SELECT data->'data'->>'deliveryId' FROM events WHERE type = 'delivery.admitted'
--     GROUP BY 1 HAVING count(DISTINCT session_id) > 1) d;

-- One opening at a time per bot: a short reservation committed before eve is called, so no row
-- lock is held across HTTP. `generation` names the main session it will install and makes eve's
-- operationId deterministic for whoever holds or later reclaims an expired reservation.
CREATE TABLE IF NOT EXISTS bot_session_openings (
  bot_id uuid PRIMARY KEY CONSTRAINT bot_session_openings_bot_id_bots_id_fk REFERENCES bots(id) ON DELETE CASCADE,
  token uuid NOT NULL,
  generation integer NOT NULL,
  operation_id text NOT NULL,
  lease_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Every session the hub opened for a bot. Installed main sessions carry their generation (the
-- order of a bot's conversations); a session that lost the install has none and waits here until
-- eve confirms it ended.
CREATE TABLE IF NOT EXISTS bot_sessions (
  session_id text PRIMARY KEY,
  bot_id uuid NOT NULL CONSTRAINT bot_sessions_bot_id_bots_id_fk REFERENCES bots(id) ON DELETE CASCADE,
  generation integer,
  operation_id text NOT NULL,
  ended_at timestamptz,
  end_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bot_sessions_generation_idx
  ON bot_sessions (bot_id, generation) WHERE generation IS NOT NULL;
CREATE INDEX IF NOT EXISTS bot_sessions_orphan_idx
  ON bot_sessions (created_at) WHERE generation IS NULL AND ended_at IS NULL;

-- A message's current delivery attempt: the session it was sent to and an attempt number that
-- fences late writers. `failure` is a fixed reason; `check_after` schedules reconciliation.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attempt integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS failure text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS check_after timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS checks integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_unresolved_idx
  ON messages (check_after)
  WHERE status <> 'accepted' AND session_id IS NOT NULL AND check_after IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_failure_check'
  ) THEN
    ALTER TABLE messages ADD CONSTRAINT messages_failure_check CHECK (
      failure IS NULL OR failure IN (
        'ambiguous', 'not_admitted', 'not_sent', 'rejected', 'session_gone', 'unconfirmed'
      )
    ) NOT VALID;
  END IF;
END $$;
ALTER TABLE messages VALIDATE CONSTRAINT messages_failure_check;

-- Backfill: today's main sessions become generation 0, so every session opened from now on sorts
-- after them. Older archived sessions stay unregistered and are ordered by time, explicitly.
INSERT INTO bot_sessions (session_id, bot_id, generation, operation_id)
SELECT session_id, id, 0, 'backfill:0026'
FROM bots
WHERE session_id IS NOT NULL
ON CONFLICT (session_id) DO NOTHING;

-- Backfill: accepted messages learn their admitting session from the stored delivery.admitted.
UPDATE messages m
SET session_id = e.session_id
FROM events e
WHERE m.session_id IS NULL
  AND m.delivery_id IS NOT NULL
  AND e.bot_id = m.bot_id
  AND e.type = 'delivery.admitted'
  AND e.data->'data'->>'deliveryId' = m.delivery_id;
