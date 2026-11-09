-- The Token Pass key lives in the hub's env (TOKEN_PASS_API_KEY), not per bot: undoes 0004.
-- Apply once, after the hub that no longer reads the column is deployed: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0005_drop_token_pass_key.sql
ALTER TABLE "bots" DROP COLUMN IF EXISTS "token_pass_key";
