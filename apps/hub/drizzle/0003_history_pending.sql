-- A session the live screen opened before any message: its first message carries the history (lib/chat/send.ts).
-- Matches `bots.historyPending` in lib/db/schema.ts. Apply once: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0003_history_pending.sql
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "history_pending" boolean DEFAULT false NOT NULL;
