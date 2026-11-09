# Remote code tasks

This document describes the remote coding capability currently present in this worktree. It is an implementation record and rollout guide, not proof of a production deployment. The code task feature is implemented around `libfx` and `durable-harness/fx`; it does not use Foreman.

## What is implemented

For an implementation request, the originating Busy bot first calls `prepare_code_repository`. An already selected repository returns immediately after a live GitHub write-access check. Otherwise its Eve workflow pauses on an inline chat card that connects GitHub, lists accessible repositories and asks the user to choose one. Reloading or returning from OAuth preserves the pending interaction. Continue saves the selected repository as this bot's context and answers the same interaction; choosing Not now returns without creating a coding task. The workflow revalidates the selected repository and connection before the bot continues the original request with `start_code_task`. The start endpoint independently requires the bot's selected repository and checks its GitHub identity and write access before accepting new work.

The originating Busy bot delegates the repository change with `start_code_task`. The tool derives a stable task id from the bot session and Eve tool call, so retrying the same call returns the same task instead of starting another implementation. It is unavailable during consultations, routine executions, and completion notifications. `get_code_task`, `update_code_task`, and `cancel_code_task` read, steer, and cancel an existing task.

The task is accepted by the hub before remote execution begins. The bot receives a task id and continues its own conversation. The coding session runs independently, and completion is delivered as a pinned service notification only when the original bot session is still the source session. A replaced bot session never receives a completion message through the replacement-session fallback; the task card remains the durable result surface.

The main implementation lives under `apps/hub/lib/code-tasks/`, with the bot-side tools in `templates/bot/agent/tools/` and the inline setup/task cards under `apps/hub/components/`. Successful `start_code_task` results create task cards at their position in the conversation; an idle chat has no permanent code-work panel. Completion envelopes are hidden from the visible user-message history and are treated as service context by the bot.

## Runtime and pinned providers

The hub pins:

| Package/profile | Current value | Role |
| --- | --- | --- |
| `durable-harness` | `0.0.1` | Durable Sandbox/Drive and harness integration. |
| `libfx` | `0.0.16` | Coding agent loop, session log, queue, leases, fencing, recovery, streaming and steering. |
| `busy-code-gateway` | named Gateway profile | Uses the bot's Gateway/OIDC billing path and selected model. |
| `busy-code-token-pass` | named Token Pass profile | Uses Token Pass explicitly; it never falls back to Gateway. |
| `busy-code-chatgpt` | named Busy subscription profile | Uses Busy's validated subscription transport, not fx's native ChatGPT endpoint. |
| `busy-code-grok` | named Busy subscription profile | Uses Busy's validated subscription transport and refresh path. |

The profiles are created once per process in `apps/hub/lib/code-tasks/runtime.ts`. A task snapshots billing, model, fast mode and profile name at acceptance. Recovery and later prompts/steers use that snapshot, not the bot's current settings or the app default. Provider requests are checked against the task session, selected model and billing mode in `apps/hub/lib/code-tasks/providers.ts`. Credentials remain server-side; they are not placed in the task record, prompt, Drive or browser. A provider error does not authorize a billing fallback.

The current agent uses `fxTools(sandbox())` and a task-owned Vercel Sandbox/Drive. `withDurableHarness` is composed with the existing Workflow integration in `apps/hub/next.config.ts`, with `flowRoute: false`; that option configures package integration and discovery, it does not generate the FX endpoint. The private FX queue consumer is the manual route `apps/hub/app/.well-known/durable-harness/v1/fx/route.ts` at `/.well-known/durable-harness/v1/fx`. It is not a browser command endpoint.

The runtime bounds each revision to 45 minutes (`REPOSITORY_RUNTIME_MS`), 120 model requests (`MAX_MODEL_REQUESTS`), 2 vCPUs, 120-second command timeouts and 2,700 VM seconds. These are execution ceilings, not completion guarantees; a task can still finish earlier with an error or `needs_attention` result.

## Durable task and command model

Migration `apps/hub/drizzle/0021_code_tasks.sql` adds:

- `code_repositories`, the app-level GitHub repository catalog;
- `code_repository_access` and `code_bot_contexts`, which record bot access and the active repository context;
- `code_tasks`, the current task projection and origin/provider snapshot;
- `code_task_commands`, the durable outbox for `start`, `steer`, and `cancel`;
- `code_task_events`, an append-only, deduplicated UI projection.

The task origin is `(bot_id, source_session_id, source_call_id)`. Branches are unique for active tasks in a repository. Every command has a stable `message_id`, expected task version, instruction version, revision, attempts and a lease. The store admits only the earliest unsent command for a task. Accepted or applied commands do not block a newly queued steer after the command-ordering fix; queued commands still retain their append-only message ids and expected-version checks.

Before a non-cancel command is sent, `reserveExecution()` locks repository rows in stable id order and reserves a slot atomically. The account has at most two active executions, and a repository has at most one. Waiting, ready, needs-attention and terminal tasks do not consume a slot; a resumed task must reserve again.

`createTask()` commits the task, its initial `start` command and `task.created` event in one transaction. The workflow then dispatches leased commands. It allocates an fx session id, associates it with the task using a version check, and only then calls `session.prompt(..., { messageId })` or `session.steer(..., { messageId })`. Replays use the same message id and input. `libfx` owns the coding loop and recovery; Busy's workflow does not wrap the model/tool loop in a second agent implementation.

The same durable session and branch are reused for corrections. `update_code_task` creates a new instruction version and uses `session.steer` on that session. The task marks the instruction applied only after the corresponding fx `user_message`/turn event is observed. Steering confirms command acceptance, not that the agent has finished the correction. A correction makes earlier verification/publication evidence stale and advances the task revision when required.

`codeTaskWorkflow` follows the outbox and projection for up to 540 five-second ticks; running out of ticks only records a `workflow.follow_ended` event. The minute cron at `/api/cron/code-tasks` calls `recoverCodeTasks()` as the second recovery path and supervisor. Neither path claims completion from an idle turn alone: a terminal result must be recorded by the task tools and publication checks.

### State transitions and fencing

Every status change goes through `transitionTask()` in `store.ts`: an `UPDATE` with the allowed source statuses and, where the decision depends on them, the expected version, session, publication lease, runtime generation or recovery fence, with `RETURNING`. Zero rows means another writer won; callers re-read or give up, never overwrite. Terminal statuses (`ready`, `failed`, `needs_attention`, `cancelled`) always carry `finishedAt` and release `executionReserved`; active statuses (`queued`, `running`, `waiting_for_input`, `cancel_requested`) never carry `finishedAt`. Migration `0027_code_task_state.sql` enforces this with `code_tasks_finished_at_check`.

Cancellation: `running|waiting_for_input|ready|needs_attention → cancel_requested → cancelled`. `cancel_requested` only means the request was accepted. `dispatchCancel` binds the in-flight cancellation to its command id (`execution.cancelCommandId`), calls `session.cancel()` and records the id of a `resume()` probe. Only that probe's `idle` line, or a `turn_end` with `stopReason: cancelled` after that dispatch, confirms the stop, by CAS from `cancel_requested`. A failed cancel dispatch leaves the task `cancel_requested`. `ask_user`, the execution limit, a failed dispatch and an ended turn all CAS from `running`, so none of them can overwrite a cancellation. A projected `turn_start`/`user_message` never revives `cancelled`, `failed` or `needs_attention`; the late command is settled. Only an explicit `steer` revives a resumable task.

Broker points: every host tool call is admitted by `admitToolCall()` (running, unfenced, same session, and the turn's `executionGeneration` from `FxToolContext.context`), which also renews `execution.runtimeHeartbeatAt`. The publication lease, the model-request lookup (`profileFor`, which also renews the heartbeat) and ChatGPT/Grok subscription credentials reject a fenced, cancelled or terminal task. Runtime-owned execution keys (heartbeat, generation, recovery, cancellation, notification outbox, workspace markers, usage) can only be written by their dedicated writers; a stale whole-object patch cannot remove them.

Supervision: a `running` or `cancel_requested` task without runtime activity (heartbeat, start or cancel request) for 15 minutes, with no queued command and no publication lease, is fenced: it keeps its status and slot, shows phase `recovering`, its `executionGeneration` is incremented and the session is asked to stop with `cancel()` plus an idle probe. Stream projection only updates `observedAt` and never counts as activity. The task becomes `needs_attention` (or `cancelled` if a cancellation was requested), with `finishedAt` and a released reservation, only after the durable session confirms the stop: one of its stop probes returns idle, or it records the turn_end. Elapsed time never resolves a recovery; without confirmation the stop request is repeated every five minutes and the task stays visibly `recovering`, holding its slot, reservation and workspace. The fence still blocks the old runtime meanwhile, but it cannot stop a call admitted before the fence, a publication already in flight, or a background process inside the sandbox. The workspace is kept; retention cleanup never forces an open run. A later explicit correction starts a turn with the new generation, so the old runtime stays rejected.

Command outbox: `queued → leased → accepted → applied → settled|failed`. Settling takes either the exact lease token of a `leased` command or the named internal mode `"unsettled"`; there is no nullable token. Accepted/applied commands of a terminal task are orphans: recovery and workspace cleanup settle them with a `command.reconciled` event instead of blocking cleanup.

Result notifications are an outbox keyed by `(revision, instructionVersion, status)`; the message id derives from the same tuple, so `waiting_for_input` followed by `cancelled` notifies twice and retries of one status reuse one id. The outcome is recorded only if the task still has the tuple that was sent. A deleted bot or replaced session records `skipped` with a reason (`bot_deleted`, `source session unavailable`) once. Cancelling a `ready` task never closes or deletes its pull request.

Bot deletion: `requestBotCodeTaskShutdown(botId)` in `bot-deletion.ts` records a `code_task_bot_shutdowns` marker (blocking `createTask` and non-cancel commands), requests cancellation of every `queued`, `running` and `waiting_for_input` task once, and returns how many tasks are still unsettled. Deletion must call it until `pending` is 0. After the bot row is deleted, tasks keep their history with `bot_id = NULL` and accept only cancellation.

## GitHub transport and repository history limits

GitHub is accessed through the existing encrypted, registered GitHub OAuth connection in `mcp_connections`. Repository setup uses the server-side token broker in `apps/hub/lib/code-tasks/github.ts`; tokens are never passed into the Sandbox environment. The conversation card adds the selected accessible repository to the catalog through the server-side broker and saves the bot's repository context only when the user presses Continue. The task freezes the repository identity and base branch at acceptance. The exact remote base SHA is resolved and pinned when `prepare_repository` starts, then recorded in the `repository.prepared` event and workspace state; acceptance does not claim that a commit was already archived.

The checkout is archive-based. The hub resolves the remote base commit and tree, downloads the GitHub archive, and transfers it through the fenced task workspace. The agent receives the files at the selected base SHA, but it does not receive the repository's complete Git history. The workspace initializes a synthetic local baseline commit for diff capture. Publication is performed through GitHub's tree/commit/ref/PR APIs, with reconciliation for an existing branch or PR; it is not an unrestricted `git push` from the Sandbox.

Current limits are deliberate:

- compressed repository archive: 25 MiB;
- extracted repository size: 200 MiB;
- archive entries/files: 20,000;
- changed file capture: 4 MiB per file;
- captured changed-file payload: 24 MiB;
- captured diff output: 4 MiB;
- archive symlinks, hard links, `.git` entries, traversal paths and special files are rejected;
- branch names must pass the restricted branch validator and cannot use `refs/`, `..`, or `//`.

These limits mean a large repository or a task requiring historical commits can be rejected or need a future transport. A GitHub archive is not a full clone, and a successful archive download is not evidence that a PR was published.

The implementation also avoids relaying large GitHub bodies through a general public hub proxy. The 25 MiB archive and 24 MiB capture limits are larger than the Vercel Function HTTP body limit; they are transferred to the fenced task workspace through bounded chunks and server-side GitHub requests instead. Production rollout still needs an end-to-end transfer check with a private repository.

## Conversational setup, task cards and events

`CodeRepositorySetupCard` renders only for the native `prepare_code_repository` question. OAuth opens the existing same-origin connect route with a validated `/b/<slug>` return path. The callback returns to that conversation without opening the marketplace. It updates the connection; it never starts a coding task.

`InlineCodeTaskCard` follows a successful `start_code_task` receipt in the chat. It polls `GET /api/code-tasks/:id?view=summary` while work is active, without downloading execution payloads or event history. Opening the card uses the existing detailed task sheet. The detail view groups projected events into activity, changes, checks and result sections. It supports correction input and asynchronous cancellation.

The task event route is `GET /api/code-tasks/:id/events`. It first projects a bounded portion of the fx stream, returns the current task snapshot, then emits `task` and `event` SSE records with a sequence cursor. The client reconnects using `Last-Event-ID`/`after`; the projector deduplicates by source key before advancing `last_stream_cursor`. A terminal task emits `end` after its persisted events are visible.

Task status polling is independent from the bot's Eve stream. A running code task does not make the main bot turn appear busy, and a task event is not stored as a fake user or assistant message. The optional completion notification is queued to the pinned originating session with a dedicated service principal and stable per-revision message id. Completion delivery failure does not change the task's result.

## Routes and authentication

Bot routes use the existing Vercel OIDC identity and derive the bot from the verified subject:

```text
GET  /api/bot/code-repository
POST /api/bot/code-tasks
GET  /api/bot/code-tasks
GET  /api/bot/code-tasks/:id
POST /api/bot/code-tasks/:id/commands
```

Browser routes are protected by the hub session gate and same-origin write checks:

```text
GET  /api/code-repositories
GET  /api/code-repositories/github
GET  /api/bots/:slug/code-repository
POST /api/code-repositories
PUT  /api/bots/:slug/code-repository
GET  /api/code-tasks?botSlug=...
GET  /api/code-tasks/:id
GET  /api/code-tasks/:id/events
POST /api/code-tasks/:id/commands
```

The bot-template tools are dynamically hidden and guarded for consultations, routine executions and the completion-notification principal, so those contexts cannot start, steer, read or cancel code work through the normal tool surface. The hub's bot routes separately authenticate the bot's Vercel OIDC subject; mutating command calls also require the supplied source session to be that bot's main session. The database uses RLS with browser-role privileges revoked, as with the other hub-owned tables.

## Rollout prerequisites

Before enabling this capability in a deployment:

1. Apply `apps/hub/drizzle/0021_code_tasks.sql` with the hub's existing server-side database connection. The presence of the migration file in this worktree does not mean it has been applied.
2. Deploy the hub with the existing stable environment and credentials: `DATABASE_URL`, `SESSION_SECRET`, `HUB_URL`, `VERCEL_TEAM_SLUG`, Vercel OIDC availability for the hub, and the existing hub signing key/public-key arrangement used by bot authentication. Keep the existing AI subscription records and refresh lock. `TOKEN_PASS_API_KEY` is required only for Token Pass tasks; it must not be used as an implicit fallback for another billing mode.
3. Keep the registered GitHub provider client and encrypted OAuth grant configured for private/repository-writing work. The wider MCP catalog also contains public no-auth entries, but the current code-task repository setup requires a connected GitHub connection. The chat card handles GitHub consent and repository selection when the agent needs them; `start_code_task` is accepted only after the server verifies the selected repository and current connection.
4. Configure the Vercel queue trigger for `__libfx_wkf_workflow_session` to the manual `/.well-known/durable-harness/v1/fx` route, with the existing Vercel/OIDC authentication boundary. Keep this trigger distinct from Workflow's `__wkf_workflow_*` consumer; do not register competing consumers.
5. Keep the existing `CRON_SECRET` configured for both `/api/cron/code-tasks` and `/api/cron/code-task-cleanup`; the first is a recovery path, not a replacement for the durable fx queue, and the second is the seven-day workspace-retention pass.
6. Run the hub build so the durable-harness package integration is applied and verify that the manual FX route, current Workflow route, bot deployment flow and existing cron routes remain present.

There is no new user-facing GitHub login hidden in the task runtime. Revoking or disconnecting the GitHub connection blocks future privileged repository operations while preserving task history and receipts.

Existing bots need one redeploy from the updated template so their bundled `prepare_code_repository`, `start_code_task`, `get_code_task`, `update_code_task` and `cancel_code_task` tools and instructions are present; newly deployed bots receive them automatically.

## Validation status and release gates

The worktree contains unit, route, database, provider, GitHub, workspace, cleanup and widget tests. They use mocked GitHub/provider responses, PGlite or test database fixtures, and a fake fenced workspace runner where appropriate. They validate idempotency, command ordering, provider isolation, secret redaction, archive traversal defenses, stream projection, cleanup leases and widget behavior. The feature had 122 focused tests in an earlier report and received additional coverage afterward; exact final counts and pass/fail remain a root-level validation result and are intentionally not stated here.

The following have **not** been demonstrated by this documentation pass:

- a real Vercel Sandbox/Drive created by `durable-harness/fx`;
- a real `__libfx_wkf_workflow_session` queue delivery and recovery;
- a real private GitHub archive download and publication;
- a real branch, commit or draft PR;
- a real subscription/Gateway request from a deployed task profile;
- a production migration, deployment or cleanup run.

The first live smoke should use a disposable private repository and exercise: accept one task, create the real Sandbox/Drive, close Busy, reconnect the event cursor, steer on the same session, run checks, publish a draft PR, lose an acknowledgement after publication, and recover without a duplicate branch/PR. Test cancellation during a model call, shell command and publication separately. Do not label the capability production-ready until these gates and the existing repository-wide checks (`pnpm check`, `pnpm lint:next`, `pnpm typecheck`, and applicable tests) pass in the target environment.

## Local validation

Run the repository checks from the root of your own clone:

```sh
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test
pnpm build
```

Feature tests use mocked providers, local database fixtures and fenced workspace
runners. They cover idempotency, command ordering, provider isolation, secret
redaction, archive traversal defenses, stream projection, cleanup leases and
widget behavior. Exact pass/fail counts are produced by the current checkout
and are intentionally not embedded in this guide.

The live gates remain environment-specific: a disposable GitHub repository,
Vercel Sandbox/Drive, the durable FX queue, a deployed task profile and the
configured provider connections. Run those checks only in an account you
control, after applying the migration above and configuring the required
secrets. This document does not claim that a migration, deployment or remote
smoke test has been run.

## Workspace cleanup

`apps/hub/lib/code-tasks/cleanup.ts` retains task workspaces for seven days
after terminal activity. It considers only `ready`, `failed`,
`needs_attention` and `cancelled` tasks; active, queued, running and
`waiting_for_input` tasks are never candidates. A candidate is rejected if it
has an active task lease or any queued, leased, accepted or applied command.

Cleanup reserves the task under a five-minute compare-and-swap lease and writes
`workspaceExpiredAt` before touching the external run. It closes a still-open
durable World run by appending the supported `run_cancelled` event, then calls
`deleteSessionSandbox(..., { force: false })` with the same World. A lost
cancellation/deletion acknowledgement is reconciled by reading the World or
retrying safely. On success it records `workspaceDeletedAt`; on failure it
releases the cleanup lease. The store rejects a later steer once either
expiration or deletion is recorded.

The authenticated cron is `GET /api/cron/code-task-cleanup`, scheduled at
`17 * * * *` with a batch limit of three and a five-minute maximum duration.
Retention never deletes GitHub branches or pull requests.
