-- A bot's own Vercel Token Pass key: it becomes the bot's AI_GATEWAY_API_KEY (lib/bots/deploy.ts).
-- Matches `bots.tokenPassKey` in lib/db/schema.ts. Apply once: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0004_token_pass_key.sql
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "token_pass_key" text;
