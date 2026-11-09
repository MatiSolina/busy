-- How each bot pays for its model: Token Pass (the hub's TOKEN_PASS_API_KEY) or AI Gateway credits (lib/bots/deploy.ts).
-- Matches `bots.billing` in lib/db/schema.ts. Bots on a Token Pass model already ran on it (set by hand on 2026-11-01).
-- Apply once, before deploying the hub that reads it: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0006_bot_billing.sql
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "billing" text DEFAULT 'gateway' NOT NULL;
UPDATE "bots" SET "billing" = 'token-pass' WHERE "model" IN ('moonshotai/kimi-k3', 'zai/glm-5.3', 'deepseek/deepseek-v4.1-flash');
