-- Fast mode per bot: AI Gateway's priority tier (lib/bots/models.ts, templates/bot/agent/agent.ts).
-- Matches `bots.fast` in lib/db/schema.ts. Apply once: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0007_fast.sql
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "fast" boolean DEFAULT false NOT NULL;
