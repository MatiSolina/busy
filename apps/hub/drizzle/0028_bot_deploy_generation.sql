-- Deploy generations (H-03/H-04) and the bot's Vercel project identity (H-08).
-- Additive and repeatable. Apply before the hub code that reads these columns.
--
-- deploy_generation: bumped by every create/redeploy/retry together with the config it builds;
--   every deploy write is conditional on it, so an older workflow can never touch a newer deploy.
-- deploy_started_at/deploy_finished_at: the deploy workflow's deadline and the reconciler's age check.
-- deploy_recoveries: how many times the reconciler restarted this generation (bounded).
-- promotion_deployment_id/promotion_until: the per-bot promotion lease. Deployments are created
--   without assigning production domains; only the lease holder promotes, one at a time.
-- vercel_project_id: the bot's Vercel project. Bot OIDC tokens must carry this project_id.
ALTER TABLE public.bots
  ADD COLUMN IF NOT EXISTS deploy_generation integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS deploy_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS deploy_finished_at timestamptz,
  ADD COLUMN IF NOT EXISTS deploy_recoveries integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS promotion_deployment_id text,
  ADD COLUMN IF NOT EXISTS promotion_until timestamptz,
  ADD COLUMN IF NOT EXISTS vercel_project_id text;

-- A deploy already in flight gets a start time, so the reconciler can age it.
UPDATE public.bots
SET deploy_started_at = updated_at
WHERE deploy_started_at IS NULL
  AND status IN ('creating', 'deploying');

-- One bot per Vercel project. The column is new, so there is nothing to deduplicate.
CREATE UNIQUE INDEX IF NOT EXISTS bots_vercel_project_id_key
  ON public.bots (vercel_project_id);

CREATE INDEX IF NOT EXISTS bots_deploy_pending_idx
  ON public.bots (deploy_started_at)
  WHERE status IN ('creating', 'deploying');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bots_deploy_generation_check'
  ) THEN
    ALTER TABLE public.bots
      ADD CONSTRAINT bots_deploy_generation_check
      CHECK (deploy_generation >= 0 AND deploy_recoveries >= 0) NOT VALID;
  END IF;
END $$;
ALTER TABLE public.bots VALIDATE CONSTRAINT bots_deploy_generation_check;
