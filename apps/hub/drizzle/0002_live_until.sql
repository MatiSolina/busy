-- Live screen (lib/live.ts): who's watching keeps the bot's computer on. Matches `bots.liveUntil` in lib/db/schema.ts.
-- Apply once: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0002_live_until.sql
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "live_until" timestamp with time zone;
