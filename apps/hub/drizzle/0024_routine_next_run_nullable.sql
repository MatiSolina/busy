-- Routines fire from Vercel Schedules (lib/routines/schedule.ts); nothing writes next_run_at anymore.
-- Matches `routines.nextRunAt` in lib/db/schema.ts. Applied to production on 2026-11-06 before the deploy.
--   psql "$DATABASE_URL_UNPOOLED" -f apps/hub/drizzle/0024_routine_next_run_nullable.sql
ALTER TABLE "routines" ALTER COLUMN "next_run_at" DROP NOT NULL;
