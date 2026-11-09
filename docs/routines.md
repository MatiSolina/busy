# Routines

Routines run a saved task through a bot at a local time on selected weekdays. All seven days means every day. They run with Busy closed and post their replies and files in the bot's existing chat. The bot has its current computer, memory, installed skills and connected MCP tools; a routine does not copy tokens or freeze a tool list.

Creation happens entirely in the conversation: “Every day at 9, review my inbox and summarize messages that need an answer.” The bot infers the name and saved task, resolves the user's time zone from the chat's client context, and calls `manage_routines` immediately. There is no form or additional confirmation step. An explicit place/time zone in the request takes precedence; the bot asks only if a necessary scheduling detail is genuinely missing or ambiguous. It confirms the saved schedule only after a successful write.

Changes work the same way: “move it to 10”, “pause the inbox routine” or “delete it”. Fields the user did not request to change, including an existing routine's stored time zone, are preserved. The **Routines** panel is a status view with the schedule, latest result and quick pause/resume/delete controls. It does not create or edit routines.

## Scheduling and delivery

- Each routine has one dynamic [Vercel Schedule](https://vercel.com/docs/schedules) (`lib/routines/schedule.ts`): name `routine-<routineId>`, namespace `bot-<botId>`, a cron built from its weekdays and `HH:mm` (`30 9 * * 1,3`), its IANA time zone (Vercel follows DST), payload `{ routineId }`, and the `routine-runs` queue topic as target. Create, edit, pause/resume and delete (from both the hub UI routes and the bot's `/api/bot/routines` tool routes) bump `routines.schedule_generation` and write one job per routine to `routine_schedule_outbox` in the same transaction; Vercel is never called inside a transaction. After the commit the request applies the job (`lib/routines/outbox.ts`); if that call fails or the process dies, the routine stays saved, the job keeps a fixed error code and retries with backoff (30 s doubling, up to 1 h) from the `/api/cron/routines` cron (every 5 minutes), which also enqueues routines that have no job for their current generation. A worker claims a job with `FOR UPDATE SKIP LOCKED` and a 15-minute lease (longer than any function may run), applies the desired state read from the routine row at that moment (a deleted or missing routine is always a delete, a paused one a disable), and marks it applied only if its generation and lease are still current; a newer change waits for the lease and is applied next, so an older enable can never land after a newer pause or delete. A delete that Vercel does not know counts as done. The outbox has no foreign key: a routine removed with its bot keeps its job until its schedule is deleted. Deleting a bot also deletes every schedule in its namespace. `scripts/backfill-routine-schedules.ts` (idempotent) recreates them from the rows.
- Schedules are per Vercel environment: production and each Preview branch keep their own. Deployed code uses its OIDC token; `vercel dev` uses its local scheduler (`vercel schedules invoke routine-<id> --namespace bot-<botId> --local`). A plain `next dev` has neither, so routines saved there never fire.
- Vercel starts a run within the jitter window (1 minute by default on Pro), at least once. `app/api/queues/routine-runs` consumes the topic: the run id is derived from the execution id, so a duplicate delivery reuses the same `routine_runs` row and the same eve message id. The route is reachable over HTTP, so before recording a run the consumer checks that the message's `scheduleId` is the routine's own schedule (`Schedules.get`; that id never leaves Vercel and the hub) and that `scheduledAt` is one of the routine's own wall-clock occurrences from the last day. The second check also drops executions published before an edit moved the routine. A new occurrence snapshots the task, so later edits cannot change work already handed off.
- One active occurrence per routine (a partial unique index) and a unique `(routine_id, scheduled_for)` constraint. A new occurrence first refreshes a still-open previous run; if that run is still active, the new one is skipped and counted on the routine (`skipped_occurrences`, `last_skipped_at`, `last_skip_reason`: `active_run`, `awaiting_input` or `duplicate_occurrence`), so a routine stuck behind an open run does not look healthy. The panel says so under the open run. Vercel delivers late runs until they expire (jitter plus one day for a daily routine), each at most once.
- Each occurrence uses a stable message UUID and a distinct service principal, `hub:routine:<runId>`, with `turnPolicy: queue`. It waits behind existing work rather than steering a user's turn or answering a pending login question. Different routines use different principals. A routine waiting for human input still needs the user to answer in chat or take control.
- The destination session is saved before sending. Lost acknowledgements retry the same UUID into the same session, even after the bot's main session changes. The occurrence is never automatically replayed into a replacement session. Errors make the queue redeliver the same occurrence a minute later. Dispatch retries five sends; an unavailable bot is waited for up to 30 deliveries (about 30 minutes), then the occurrence is recorded as failed and the next one runs normally. A known ended/lost session is recorded as a delivery failure and the next occurrence can open a fresh session.
- A bot without a session gets one from the shared main-session helper between two short transactions: the opening is reserved and committed, eve is called with no row lock held, and the install is a compare-and-set. If a chat or Live installed a session meanwhile, the occurrence uses that one and the routine's own session is ended.
- A durable workflow, started by the consumer (again on every redelivery), synchronizes the pinned session every 15 seconds for up to two hours. The end of the workflow is not the end of the turn: a run still `dispatched` after that is observed by the `/api/cron/routines` sweep (`recoverRoutineRuns`, every five minutes, for runs nobody observed in the last ten), always through the session pinned at admission. A run becomes `failed` only on evidence that its session is gone (`session.ended`, 404/410 or an unavailable-session code from eve), with a transition conditional on the run still being `dispatched` on that session, so a terminal recorded first always wins. A turn paused on a question, approval or sign-in stays `dispatched` (waiting for input) however long Mati takes; age alone never fails a run, and the bot's main session is retired only while it still is the gone session. Completion follows the occurrence's delivery and matching turn, including a turn that resumed after human input. Acceptance alone is not completion.
- `succeeded` means eve completed the matching turn. It is not independent proof that every external business action succeeded; the bot's reply and tool results remain the evidence of what it did.
- Pausing, editing or deleting cancels occurrences that have not been handed off. Already handed-off work may finish. Deletion hides/disables the routine while retaining occurrence records for recovery and audit.

The Routines panel shows the latest occurrence below each schedule. It labels a
run as running, waiting for you (a `dispatched` run whose turn is paused on a question, approval or sign-in: `routine_runs.awaiting_input_at`, exposed as `lastRun.awaitingInputSince`; the public status stays `dispatched`), completed, cancelled or failed and keeps the last safe reason
when one is available. Provider failures include the provider and a next step,
such as reconnecting ChatGPT or Grok in Settings, checking usage, waiting out
a rate limit, or choosing a supported model in bot Settings. An old or unknown
error is reduced to “The last run failed. Check this bot's chat for details.”
so provider response bodies and credentials are never rendered from legacy
rows. The panel does not rerun an occurrence or mutate its result; the user
can fix the connection and wait for the next schedule, or send a new request
in the bot's chat when an immediate run is needed.

Routine execution keeps the bot's selected billing path. A ChatGPT/Grok grant
that expires asks for reconnection, a Token Pass or Gateway allowance failure
points to usage or another connection, and a temporary provider or rate-limit
failure can be retried by the next dispatch. Busy does not silently switch the
routine to a different provider. Transport retries are still bounded and use
the same occurrence id so a lost acknowledgement cannot duplicate the task.

## Access and endpoints

The normal Busy session protects `/api/bots/:slug/routines` (GET/POST) and `/api/bots/:slug/routines/:id` (PATCH/DELETE). The corresponding `/api/bot/routines` endpoints derive the owning bot from verified OIDC, never from a model-supplied bot id. Consultations and local subagents cannot use `manage_routines`.

Create requires a stable UUID, name, prompt, `HH:mm` time and IANA `timeZone`. `daysOfWeek` defaults to all days (0 = Sunday, 6 = Saturday). Patch also accepts `enabled`. Unknown fields, invalid schedules and bodies over 32 KiB are rejected. There is a limit of 100 non-deleted routines per bot. Both tables have RLS enabled and all privileges revoked from `anon` and `authenticated`; only the hub's server-side database connection accesses them. This follows the existing hub data-access model and [Supabase's grant/RLS guidance](https://supabase.com/docs/guides/database/postgres/row-level-security).

## Release and verification

1. Apply `apps/hub/drizzle/0030_routine_recovery_schedule_outbox.sql` (additive, re-runnable) before deploying hub code that reads its columns; it backfills one pending schedule job per existing routine, which the cron applies once. Apply `apps/hub/drizzle/0011_routines.sql` through the project's existing Drizzle/Postgres migration process before enabling the new hub code. Keep prior migrations in place. No existing bot, computer or chat needs resetting. `0024_routine_next_run_nullable.sql` makes `next_run_at` optional; it and the run leases (`lease_token`, `lease_until`, `retry_at`) are unused since Vercel Schedules and stay until the performance A/B can drop a column that the base branch still reads.
2. Deploy the hub with the existing database connection, signing key and bot-domain configuration. `vercel.json` subscribes `app/api/queues/routine-runs` to the `routine-runs` topic. Check the routine schedules with `vercel schedules list --namespace bot-<botId>` and their runs with `vercel schedules executions list routine-<id> --namespace bot-<botId>`.
3. Redeploy existing bots from the updated template so they receive `manage_routines` and its instructions. Preserve each bot's session and Drive.
4. With a disposable bot and connected test MCP, ask in chat for a routine at a nearby local minute. Confirm the bot saves it without a form or extra confirmation, using the chat's time zone when none was stated. Close the app and confirm one run, one queued delivery, the actual MCP action and a reply/file in chat. Ask the bot to pause/delete the routine afterwards.

Local automated coverage uses a real PostgreSQL engine (PGlite) for ownership, grants, constraints, schedule sync calls, duplicate deliveries, retries and occurrence state, plus mocked eve/Schedules calls for dispatch and correlation. These checks do not substitute for the post-deployment MCP acceptance test above.

The remaining acceptance work includes deploying the updated bot template and
running one disposable routine for each billing path with Busy closed: a normal
completion, a provider rate limit, a disconnected subscription, a Gateway
budget/Token Pass allowance failure, and a retry after recovery. Verify that
the panel shows the safe provider guidance, that no run is replayed into a new
session, and that the chat contains the corresponding bot reply or failure
evidence.

On 2026-11-02, migration `0011_routines.sql` was applied to the configured shared Supabase database as `bot_routines`. Both new tables have RLS enabled and no `anon`/`authenticated` data access. The local routine-list endpoints returned HTTP 200 for both existing bots. The panel separates load failures from an empty list and offers Retry. No routine executions were created by these checks. Hub/bot code deployments and the real scheduled MCP acceptance test remain pending.
