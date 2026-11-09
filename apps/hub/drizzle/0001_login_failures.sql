-- Login rate limit (lib/auth/rate-limit.ts). Matches `loginFailures` in lib/db/schema.ts.
-- Apply once: psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0001_login_failures.sql
CREATE TABLE IF NOT EXISTS "login_failures" (
  "ip" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "login_failures_at_idx" ON "login_failures" USING btree ("at");
