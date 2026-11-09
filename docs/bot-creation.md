# Bot creation

Creating a bot sends only its name, what it does, the selected avatar, and an
optional catalog `templateId` to `POST /api/bots`. The hub resolves template
instructions from `apps/hub/lib/bots/marketplace.ts`; it never accepts
instructions from the create form. An absent `templateId` means a blank
instruction set. An unknown template id is rejected with `400`.

Skills, plugins and MCP connections are managed once in the app settings, even
before creating a bot. They are not part of bot configuration. Every bot can
choose the enabled skills and connected tools relevant to its current task.

The hub selects the initial language model with AI SDK's experimental
`experimental_decide` API. The decision request runs server-side through AI
Gateway using the deployment's Vercel OIDC authentication (or the server-only
`AI_GATEWAY_API_KEY` configured by the operator). The browser and deployed bot
never receive that credential. The decision question exposes only models marked
`tokenPass` in `apps/hub/lib/bots/models.ts`; the result is checked against that
allowlist before it is persisted. New bots therefore start with
`billing: "token-pass"` and `fast: false`.

Decision API is experimental and can fail because of credentials, provider
availability, timeout, refusal, or a malformed answer. Creation does not fail
for those cases: the hub uses `moonshotai/kimi-k3` as a deterministic fallback.
This fallback is still a Token Pass model. A later configuration edit can
change the model, billing, or Fast setting and triggers the existing redeploy
behavior.

The implementation follows the [AI Gateway Decision
Quickstart](https://vercel.com/docs/ai-gateway/getting-started/decision) and the
[AI SDK decisions contract](https://ai-sdk.dev/docs/ai-sdk-core/decisions). The
API remains experimental; keep the `ai` lockfile version pinned and test the
choice validation and fallback paths when upgrading it.

## Deploys: generations, promotion and recovery

Migration `apps/hub/drizzle/0028_bot_deploy_generation.sql` adds the deploy
generation, its timestamps, the per-bot promotion lease and
`bots.vercel_project_id`.

- **Generation.** Creating a bot saves generation 1; a PATCH that changes the
  prompt, model, billing or Fast, any save of a `failed` bot, and an explicit
  `PATCH {"retry": true}` (only from `creating` or `failed`, else `409`) bump
  `deploy_generation` in the same UPDATE as the config. `deployBotWorkflow`
  receives `{ botId, generation, v: 2 }` (a bare slug, the v1 argument, adopts
  the row's current generation). Every deploy write is conditional on the
  generation and, after the build starts, the exact `deployment_id`: a run of
  an older generation stops at its next step and never writes `ready`/`failed`
  over a newer one. If `start()` throws, the route marks that generation
  `failed` (retryable) instead of leaving `creating`.
- **Promotion.** Deployments are created with `target: "production"` and
  `autoAssignCustomDomains: false` (the pinned CLI's `deploy --prod
  --skip-domain`): they build with the production environment and OIDC claims
  but are not published. Once READY, the run claims the bot's promotion lease
  (`promotion_deployment_id`, `promotion_until`, 2 minutes) with a conditional
  UPDATE and calls `POST /v10/projects/{id}/promote/{deployment}`. The bot
  becomes `ready` only after the project's `lastAliasRequest` reports that
  deployment as `succeeded` (or `skipped`: already production). A newer
  generation that finds the lease held by another deployment waits until
  Vercel reports that request settled, or the lease expired without the
  request appearing. Remaining window: Vercel has no fencing token for the
  promote call, so a request that stays invisible longer than the lease could
  still land after a newer promotion. A promotion done by hand in Vercel is not
  reconciled.
- **Deadline and reconciliation.** A run gives up 35 minutes after
  `deploy_started_at`: a build Vercel still reports as building becomes a
  retryable `failed`; an unreachable Vercel leaves the row as it was.
  `ready` with no session is a successful deploy; opening the session is not
  the deploy's job. The cron `/api/cron/deploys` (every 5 minutes) restarts a
  `creating` generation idle for 10 minutes or a `deploying` one idle for 40
  with one new run of the same generation, claimed by a conditional increment
  of `deploy_recoveries`. That run adopts the recorded deployment instead of
  building another. After 3 restarts the generation becomes `failed` ("could
  not confirm"), retryable.
- **Deletion interface.** A run stops when the row is gone or has a non-null
  `deletionState` (column owned by the deletion flow).

## Bot identity

A bot's identity toward the hub is its Vercel project, not its slug. The
deploy stores the id `ensureProject` returns in `bots.vercel_project_id`
(unique) and refuses to deploy a linked bot into a different project named
`bot-<slug>`. `botFromRequest` verifies the OIDC token (issuer, audience,
`environment: production`, subject `bot-<slug>`), then requires the
`project_id` claim to be the bot's linked project and the subject's slug to be
that bot's current slug. A token without `project_id`, from an older project
with the same slug, or with a different slug gets `401`.

Publication: by default a deployment still publishes itself (`autoAssignCustomDomains`) and READY
means production; the hub's writes are fenced by generation either way. `BOT_DEPLOY_PROMOTION=on`
builds production deployments without assigning domains and publishes the current generation's
deployment through `POST /v10/projects/{id}/promote/{deploymentId}` under a per-bot lease. Turn it on
only after a QA bot was deployed with it: it has not been exercised against Vercel yet.

Rows deployed before 0028 are unlinked. `BOT_OIDC_ALLOW_UNLINKED=1` is an
explicit, temporary compatibility window that matches an unlinked row by slug;
it never applies to a linked row. Rollout:

1. Preflight (read-only): `SELECT status, count(*) FROM bots GROUP BY 1;` and
   `SELECT conname FROM pg_constraint WHERE conrelid = 'public.bots'::regclass;`
   (no `bots_vercel_project_id_key` / `bots_deploy_generation_check` yet).
2. Apply 0028. Wait until no bot is `creating`/`deploying` (runs started by
   the previous hub keep running its code).
3. `pnpm exec tsx --env-file=.env.local scripts/backfill-bot-project-ids.ts --dry-run`,
   then without `--dry-run`. It links a row only when the team project
   `bot-<slug>` holds the row's own recorded deployment; it reports
   `mismatch`, `missing`, `taken`, `no-deployment` and `error` rows and leaves
   them unlinked. Idempotent.
4. Deploy the hub. If some bot is still unlinked, set
   `BOT_OIDC_ALLOW_UNLINKED=1` only until a redeploy (which links it) or a
   repaired backfill; then remove it.
