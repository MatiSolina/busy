# Busy architecture

This document explains the public Busy application in this repository. The public
package contains the Hub, the Desktop client, the bot template, the bot computer
image and reusable agent skills. The marketing site is intentionally outside
this package and is maintained privately.

The shortest useful model is: Busy is a control plane for durable bot sessions.
The Hub owns identity, policy, persistence and orchestration. Each bot runs as
an independently deployable Eve application with its own Vercel project,
durable session and isolated computer.

~~~mermaid
flowchart LR
    U[User] --> D[Busy Desktop or browser]
    D --> H[Hub Next.js Route Handlers]
    H --> DB[(Postgres Drizzle + migrations)]
    H --> B[(Private Vercel Blob)]
    H --> W[Vercel Workflow runs]
    H --> Q[Vercel Queues + Schedules]
    W --> P[Bot Vercel project]
    P --> E[Eve durable session]
    E --> S[Vercel Sandbox + Drive]
    H --> G[AI Gateway or subscription provider]
    E --> G
    H --> M[MCP servers + isolated App sandbox]
    D --> H
~~~

The diagram is a deployment model, not a claim that every request traverses
every box. A normal message uses the Hub, a selected bot session and a model. A
routine also uses a schedule, queue and workflow; a file uses Blob; and a coding
task adds a durable task runtime and a user-owned Git provider.

## Why this architecture

The architecture follows the workload instead of forcing every operation into
one runtime.

| Workload | Boundary | Reason |
| --- | --- | --- |
| Login, settings, chat APIs, uploads and streamed events | Next.js Route Handlers in <code>apps/hub</code> | They need the browser session, database transaction and HTTP streaming boundary. |
| A bot's model/tool loop | Eve in <code>templates/bot</code> | Eve owns the durable conversation protocol, turns, interactions and tool lifecycle. |
| A bot's computer | Vercel Sandbox plus a Container Registry image | Desktop, browser, Office and PDF tools require a disposable Linux environment with system dependencies. |
| Bot deployment, deletion, live watching, routines and recovery | Vercel Workflow | These operations outlive one HTTP request and need retries, sleeps, checkpoints or cancellation. |
| Short background delivery | Vercel Queues | Queue delivery separates a committed database outbox from its consumer. |
| Reconciliation and periodic work | Vercel Schedules | A static schedule starts a bounded HTTP handler; the handler claims rows and starts or advances durable work. |
| Chat files, library objects and optional Desktop archives | Private Vercel Blob | Blob stores bytes; Postgres stores ownership, metadata and state. |
| Model routing | Vercel AI Gateway through the AI SDK, or an explicitly configured subscription provider | Provider credentials stay server-side and billing mode is explicit. |
| Provider identity between Hub and bots | Vercel OIDC plus short-lived Hub-signed JWTs | The Hub verifies the bot project and a bot verifies the Hub and bot audience. |
| Local and production data | Postgres through Drizzle and <code>postgres</code> | Relational transactions, unique constraints, row-level security and migrations protect state transitions. |
| Mac shell | Electron in <code>apps/desktop</code> | The client needs native windowing and packaging while the Hub remains the source of truth. |

This is why Busy does not put a model key in Desktop, store the conversation in
Electron, run a long-lived Hub process, or put every bot in one shared sandbox.
Those choices move secrets and mutable state into the least controllable boundary.

## Repository boundaries

~~~text
apps/hub/                 control plane and authenticated web app
  app/                    pages and Route Handlers
  components/             browser UI
  lib/                    database, auth, chat, bots, files, MCP and providers
  workflows/              durable Workflow definitions
  drizzle/                ordered SQL migrations
  scripts/                local setup, template bundling and checks
apps/desktop/             Electron macOS shell; no model or database logic
templates/bot/            source for every deployed Eve bot
  agent/                  Eve agent, skills, tools, channels and sandbox selector
  package-lock.json       standalone bot dependency snapshot
images/bot-base/          Dockerfile and scripts for the bot computer image
skills/busy-setup/        reusable self-hosting procedure
docs/                     operational contracts, security notes and this guide
.github/                  affected CI planning and validation workflows
~~~

There is no second public frontend in this package. The Hub is the application
surface; Desktop is its native shell.

The generated <code>apps/hub/lib/bots/template.generated.json</code> is produced
from <code>templates/bot</code> by <code>scripts/bundle-template.mjs</code>. It
lets the Hub deploy the bot source without reading a maintainer checkout at
runtime. The generated file is ignored and recreated by the build, test and
typecheck tasks; do not hand-edit or commit it. Run
<code>pnpm --filter hub bundle-template</code> after a bot-template change when
you need to inspect the bundle locally.

## Runtime topology and trust boundaries

~~~mermaid
sequenceDiagram
    participant Browser as Browser or Desktop
    participant Hub as Hub
    participant DB as Postgres
    participant Bot as Bot project
    participant Eve as Eve session
    participant VM as Sandbox + Drive
    participant Model as AI Gateway/provider

    Browser->>Hub: authenticated message
    Hub->>DB: insert message and delivery state
    Hub->>Bot: short-lived Hub JWT scoped to bot
    Bot->>Eve: POST /eve/v1/session/{id}
    Eve->>VM: tool/computer work when needed
    Eve->>Model: model request with bot configuration
    Eve-->>Bot: stream v27 events
    Bot-->>Hub: authenticated stream/callback
    Hub->>DB: persist events and projections
    Hub-->>Browser: SSE/chat projection
~~~

The browser owns a session cookie only. It does not receive
<code>VERCEL_TOKEN</code>, <code>BLOB_READ_WRITE_TOKEN</code>,
<code>HUB_SIGNING_KEY</code>, an AI Gateway key, a database URL or private MCP
OAuth tokens. Desktop receives the Hub URL as trusted launch configuration, but
still loads the UI and session from the Hub.

The Hub authenticates browser writes with the session cookie and same-origin
checks in <code>apps/hub/proxy.ts</code>. Bot-facing routes use the bot's Vercel
OIDC subject and project ID. Hub-to-bot messages use a five-minute ES256 JWT
whose audience is the bot slug. Consultation credentials use a separate
audience namespace and identify both bot IDs. These are deliberately different
credentials: possession of one bot's OIDC token must not grant another bot's
session.

The bot computer is a second boundary. <code>templates/bot/agent/sandbox.ts</code>
requires the operator's digest-pinned <code>BOT_BASE_IMAGE</code>, opens a
Sandbox in <code>iad1</code>, mounts the bot's Drive at <code>/data</code>, and
uses a snapshot plus <code>networkPolicy: deny-all</code> for read-only
consultations. The Hub records the public sandbox name for Live viewing; it does
not derive or expose provider credentials to the browser.

## The message path

1. A browser or Desktop client posts to a Hub route. The proxy verifies the
   session cookie and rejects cross-site writes.
2. The Hub validates the bot slug, message shape, files and turn policy, then
   persists the message and delivery identity in Postgres.
3. <code>apps/hub/lib/chat/session.ts</code> ensures a main Eve session exists.
   Session creation is idempotent through an operation ID.
4. <code>apps/hub/lib/eve/client.ts</code> calls the bot's
   <code>/eve/v1/session</code> API. The message ID is Eve's idempotency key;
   retries return the same delivery instead of creating a second turn. A short
   <code>session_not_ready</code> retry budget covers a bot moving to a new
   deployment.
5. Eve runs the model and tools. The dynamic model in
   <code>templates/bot/agent/agent.ts</code> selects a saved model, fireside
   model or subscription proxy. <code>agent/channels/eve.ts</code> verifies Hub
   and consultation credentials.
6. The Hub consumes stream v27 records, persists event metadata needed for
   replay, and projects them into chat items in <code>lib/chat/items.ts</code>.
   The browser receives the safe projection over SSE; it does not receive
   provider secrets or arbitrary tool payloads.
7. Recovery paths reconcile an interrupted delivery by message, delivery,
   session and turn IDs. An ambiguous provider response remains retryable
   rather than becoming a second successful message.

The invariant is that the chat UI is a projection. It can reconnect, replay and
settle an interaction without being the source of truth for the conversation.

## Bot creation and deployment

Bot creation is a control-plane transaction followed by a durable deployment.
The create route accepts a bot name, description, avatar and optional catalog
template ID. It resolves instructions from Hub marketplace code; the browser
cannot inject an arbitrary prompt into a marketplace template.

<code>apps/hub/lib/bots/service.ts</code> performs these idempotent steps:

1. Ensure a Vercel project named <code>bot-&lt;slug&gt;</code> exists in the
   operator's team.
2. Verify an existing bot row is still linked to that exact project ID.
3. Set the bot's Hub URL, team slug, public signing key, image digest and
   optional provider credential as project environment variables.
4. Add the bot's custom domain under <code>BOTS_DOMAIN</code>.
5. Bundle the Eve source and create a production deployment without silently
   selecting another operator's image or project.
6. Wait for Vercel to report the deployment ready, promote it under the
   per-bot lease, and open or adopt the main Eve session.

<code>apps/hub/workflows/deploy-bot.ts</code> makes the sequence durable. A
deploy generation is stored with the bot row; every database write checks the
current generation and deployment ID, so an older retry cannot overwrite a
newer prompt or model. A 35-minute deadline and
<code>/api/cron/deploys</code> reconciler turn an ambiguous Vercel response into
a retryable state. Deletion marks a tombstone and the delete workflow removes
project and Blob state without allowing a late deploy to resurrect it.

The operator must publish the computer image first.
<code>images/bot-base/Dockerfile</code> starts from Eve's public base, adds Linux
desktop/browser/Office/PDF tooling, and copies wrappers plus
<code>/etc/busy-image-version</code>. <code>images/bot-base/push.sh</code> refuses
to run unless <code>BOT_BASE_IMAGE_REPOSITORY</code> explicitly names the
operator's own Vercel Container Registry repository. The Hub validates the
digest-pinned <code>@sha256:</code> reference before deploying a bot.

## Durable work: Workflow, Queues and Schedules

Busy uses three levels of asynchronous execution:

~~~mermaid
flowchart TD
    HTTP[Route Handler] --> TX[Postgres transaction]
    TX --> OUTBOX[Outbox row]
    OUTBOX --> QUEUE[Vercel Queue]
    QUEUE --> CONSUMER[Queue route]
    CONSUMER --> WF[Vercel Workflow]
    WF --> STEP[Provider or Hub step]
    STEP --> SLEEP[Durable sleep or retry]
    SLEEP --> STEP
    SCHEDULE[Vercel Schedule] --> RECONCILE[Claim stale rows or start workflow]
    RECONCILE --> WF
~~~

Use a route for a short request, a Queue when a committed event must be
delivered asynchronously, and a Workflow when progress must survive a process
restart or wait on a provider. A Schedule entry is a trigger, not a durable
job: the scheduled handler claims rows and starts or advances a workflow.

Hub Workflow definitions include bot deploy/delete, routine delivery, turn
synchronization, live watching, file/library verification, history embeddings,
firesides and code-task supervision. The code-task Workflow supervises
<code>durable-harness</code>/<code>libfx</code>; the actual agent loop owns its
durable World and the Hub follows its task projection and outbox. This avoids
running a second competing state machine in the Hub.

<code>vercel.json</code> declares queue topics and static scheduled routes. The
Hub also uses <code>@vercel/schedules</code> for routine schedule management.
Schedules are small reconciliation loops: deploy recovery every five minutes, code-task
supervision every minute, routines every five minutes, cleanup and
embedding/library jobs at their own bounded cadence. Each route authenticates
the scheduler or queue request and claims rows with conditional updates before
calling external systems.

Official product references:

- [Vercel Functions](https://vercel.com/docs/functions) — Hub Route Handlers.
- [Vercel Workflow](https://vercel.com/docs/workflows) — durable steps, retries,
  sleeps and resumable execution.
- [Vercel Queues](https://vercel.com/docs/queues) — at-least-once background
  delivery and consumer routes.
- [Vercel Schedules](https://vercel.com/docs/schedules) — static scheduled
  targets defined in <code>vercel.json</code>. Busy keeps
  <code>/api/cron/*</code> as an internal route naming convention; the
  deployment configuration uses Schedules rather than the legacy Cron Jobs
  product.

## Data and storage

Postgres is the authoritative control-plane store. Drizzle definitions live in
<code>apps/hub/lib/db/schema.ts</code>; numbered SQL migrations add constraints,
RLS, indexes and SQL-only objects. <code>apps/hub/scripts/init-db.ts</code>
initializes a new empty database transactionally and refuses one that already
has public relations. The app uses pooled/runtime <code>DATABASE_URL</code> and
the direct migration URL when the provider supplies
<code>DATABASE_URL_UNPOOLED</code>.

Major relational groups are:

- accounts and login failures;
- bots, deployment generations, project IDs and tombstones;
- messages, events, delivery attempts, sessions and recovery bindings;
- routines, routine runs and schedule outbox rows;
- files, library objects, verification state and cleanup leases;
- MCP connections/provider clients and sealed app results;
- AI settings/subscriptions and model usage;
- firesides, participants, commands and runtime metadata;
- code repositories, tasks, commands, checkpoints and workspace state.

Private Vercel Blob stores bytes that should not live in Postgres: chat files,
library content and optional Desktop archives. The database stores ownership,
path policy, content metadata, verification and lifecycle state. Blob URLs and
provider tokens are never placed in public chat projections or operational
logs. See the [Vercel Blob documentation](https://vercel.com/docs/vercel-blob).

This split is deliberate: database transactions decide who may read or mutate
an object, while Blob handles object bytes and retention. A Blob failure leaves
database state retryable; a missing owner row never grants access to a URL.

## AI providers and identity

The Hub and bots can use different billing paths, but every path is explicit:

- AI Gateway models use the deployment's Vercel OIDC token or a server-only
  <code>AI_GATEWAY_API_KEY</code> configured by the operator.
- Token Pass is passed only to the bot project that needs it; the Hub refuses a
  Token Pass deployment when its key is missing.
- ChatGPT/Grok subscription paths use a Hub-mediated subscription connection;
  Desktop's OAuth broker sends completion back to the Hub, not directly to a
  model provider.
- Model selection and optional priority are validated against catalog and
  provider capability checks. An unsupported Fast request does not become a
  hidden provider promise.

The model sees bot instructions, selected tools and allowed connection metadata;
the browser does not receive model credentials. AI Gateway provides a common
model-routing boundary; see [Vercel AI Gateway](https://vercel.com/docs/ai-gateway).

Vercel OIDC is used for project identity instead of copying a long-lived Vercel
token into every bot. See [Vercel OIDC federation](https://vercel.com/docs/oidc).
The Hub still needs an operator-scoped Vercel token for management actions such
as creating projects and updating environment variables. That token stays in
the Hub deployment.

## MCP Apps and external connections

MCP discovery, OAuth, provider-client registration and tool calls are server
side in <code>apps/hub/lib/mcp</code>. OAuth tokens are encrypted with the
session secret and never sent to the browser. A connected MCP App is rendered in
an isolated iframe on <code>MCP_APP_SANDBOX_ORIGIN</code>, which must differ from
<code>HUB_URL</code>. The sandbox proxy denies camera, microphone, geolocation
and direct cookie/storage access, and the Hub rechecks the connection and tool
permission for every action.

The model receives an opaque app-result reference and safe tool content; private
result metadata is recovered by the authenticated host. This preserves Eve's
chat projection while keeping an untrusted app from choosing an arbitrary
connection or reading Hub cookies. See [MCP Apps in Busy](mcp-apps.md) and
[Vercel MCP](https://vercel.com/docs/mcp).

## Desktop architecture

The Desktop client is intentionally thin:

1. <code>main.mjs</code> creates a sandboxed, context-isolated Electron window
   with <code>nodeIntegration: false</code>.
2. The window loads <code>BUSY_URL</code> (defaulting to the official hosted Hub
   at <code>https://app.busybot.dev</code>), and <code>url-policy.mjs</code>
   allows only that origin in the main frame. A self-hosted operator must set
   <code>BUSY_URL</code> explicitly to their own Hub.
3. <code>preload.cjs</code> exposes a small IPC surface. The ChatGPT broker accepts
   callbacks only from the trusted Hub origin and forwards completion to the Hub
   with the current session.
4. The shell handles offline/recovery pages, renderer crashes, hangs and retry
   budgets without putting a second chat implementation in the app.
5. The release helper computes and publishes the archive hash. The native
   client verifies SHA-256 and bundle identity before the atomic/rollback-aware
   swap implemented in <code>update.mjs</code>.

The source build targets Apple Silicon:
<code>pnpm --filter busy-desktop dist</code>. A self-hosted operator must
publish an own archive and set <code>BUSY_APP_VERSION</code> and
<code>BUSY_APP_SHA256</code> if they want <code>/install</code> or self-update;
running the Hub does not silently publish a maintainer Desktop binary.

## Why the Hub and bot are separate projects

Putting every bot in the Hub process would couple user traffic, model turns,
computer access and deployment failure. Separate bot projects provide:

- a project-level OIDC identity and deployment lifecycle;
- independent Eve sessions and workflow state;
- a per-bot domain and sandbox image contract;
- a smaller blast radius for a prompt/tool/runtime defect;
- the ability to move one bot to a new deployment while other bots continue.

The cost is operational: a self-host requires Vercel project creation, wildcard
DNS, image publication and enough team quota. That cost is explicit in setup
instructions instead of hidden behind a shared privileged runtime.

## Modification guide

Start by identifying which boundary owns the behavior.

| Change | Edit | Follow-up |
| --- | --- | --- |
| Hub page or chat component | <code>apps/hub/app</code>, <code>apps/hub/components</code> | Run Hub tests, typecheck and <code>pnpm lint:next</code>. |
| Browser/API contract | <code>apps/hub/app/api</code> and nearest <code>apps/hub/lib</code> | Add or adjust a route/contract test; preserve auth and projection boundaries. |
| Bot behavior, prompt, tool or built-in skill | <code>templates/bot/agent</code> | Rebundle; run bot tests and context-budget check. |
| Bot computer dependency | <code>images/bot-base/Dockerfile</code>, wrappers or <code>desktop/</code> | Bump <code>image-version</code>, build/push own digest, update <code>BOT_BASE_IMAGE</code>, run image tests. |
| Database table/constraint/index | <code>schema.ts</code> plus a new ordered <code>apps/hub/drizzle/*.sql</code> migration | Run <code>pnpm --filter hub db:validate</code>, schema drift and migration tests. Never use <code>drizzle-kit push</code> on an existing DB. |
| Durable operation | <code>apps/hub/workflows</code> plus owning store/outbox | Make steps idempotent, fence writes by generation/lease, add recovery and cancellation tests. |
| AI provider/model policy | <code>apps/hub/lib/ai</code>, bot config/deploy files | Keep credentials server-side; make provider/billing changes explicit. |
| MCP connection/App sandbox | <code>apps/hub/lib/mcp</code>, sandbox route, <code>docs/mcp-apps.md</code> | Re-run origin, CSP, OAuth, permission and app-result tests. |
| Desktop behavior | <code>apps/desktop</code> | Run Electron tests on macOS; keep Hub as source of truth. |
| CI selection | <code>.github/scripts/ci-plan.mjs</code>, workflow and policy tests | Add package/task mapping and affected-plan cases. |

After a bot-template change, the generated bundle must be in the same change.
The bundler excludes <code>.env*</code>, symlinks, caches and local agent
folders. This is a publication boundary as well as a build optimization.

## Local development

The supported local path is deterministic:

~~~sh
corepack enable
pnpm install --frozen-lockfile
pnpm --filter hub setup:local
pnpm --filter hub hash-password
# Put the literal hash in apps/hub/.env.local.
docker run --name busy-postgres \
  -e POSTGRES_USER=busy -e POSTGRES_PASSWORD=busy -e POSTGRES_DB=busy \
  -p 127.0.0.1:5432:5432 -d postgres:16
cd apps/hub
NODE_OPTIONS=--env-file=.env.local pnpm db:init
pnpm dev
~~~

<code>db:init</code> is for an empty database and handles plain Postgres;
<code>db:validate</code> runs baseline and migrations against PGlite without a
provider. To exercise a real bot, link a Hub project in your own Vercel team,
publish an own image and set the production variables in
<code>skills/busy-setup/SKILL.md</code>. A local Hub can use a deployed
development relay, but relay token and fingerprint remain private to that
operator.

## Deployment model

The public repository expects a Vercel project named <code>busy-hub</code>
rooted at <code>apps/hub</code>. The name is part of Hub OIDC subject
validation. Provision:

1. an empty Postgres database and runtime/direct URLs;
2. a private Blob store and <code>BLOB_READ_WRITE_TOKEN</code>;
3. Hub secrets, team ID/slug, HTTPS URL and separate MCP sandbox origin;
4. a wildcard bot domain;
5. a digest-pinned bot computer image in the operator's Container Registry.

Deploy Hub, verify login and protected API, then create a bot and watch the
actual deployment reach Ready. Do not infer runtime health from a successful
build: the first bot smoke should send one message and open its computer.

The relevant Vercel product references are [Functions](https://vercel.com/docs/functions),
[Workflow](https://vercel.com/docs/workflows), [Queues](https://vercel.com/docs/queues),
[Schedules](https://vercel.com/docs/schedules),
[Blob](https://vercel.com/docs/vercel-blob), [Sandbox](https://vercel.com/docs/sandbox),
[AI Gateway](https://vercel.com/docs/ai-gateway),
[OIDC](https://vercel.com/docs/oidc), [Container Registry](https://vercel.com/kb/vercel-container-registry),
and [Marketplace storage](https://vercel.com/marketplace/category/storage).

## Tests and what they prove

The default <code>pnpm test</code> suite is provider-independent. It covers Hub
routes, state machines, authorization, migrations, chat projection, MCP
permissions, bot contract behavior, computer wrappers and Desktop updater
recovery with fake Vercel/provider boundaries. It does not claim that a real
Vercel Sandbox, Blob store, AI Gateway request or external Git provider ran.

Run repository checks before a change is merged:

~~~sh
pnpm quality:doctor
pnpm check:tooling
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test -- --maxWorkers=2
pnpm build
pnpm --filter hub check:runtime
~~~

Browser performance and PostgreSQL multi-connection tests are opt-in. Run the
commands documented in their nearby README/tests and run infrastructure smokes
only against resources the operator controls. The CI planner uses Turbo
affected tasks for ordinary pull requests and full validation for shared
configuration changes.

## Failure and recovery invariants

Busy treats external systems as eventually consistent. Durable state is kept in
Postgres and every external side effect has a recovery path:

- message retries use stable message/delivery IDs;
- deploys use generation checks, project identity and promotion leases;
- routines use a unique occurrence and an outbox generation;
- code tasks use leases, checkpoints and a durable-harness World;
- Blob verification and cleanup are retryable and ownership-checked;
- live-screen control is a lease, so a stale viewer cannot retain control;
- Desktop updates stage, verify, swap, confirm and roll back.

The implementation intentionally logs bounded lifecycle metadata instead of
prompts, transcripts, signed URLs, credentials or tool payloads. For the
operation map see [operation observability](operation-observability.md).

## What this architecture does not promise

The source tree and deterministic tests do not provide Vercel quota, model
credits, a Postgres provider, a Blob store, wildcard DNS, a Container Registry
image or GitHub OAuth. Those are operator-owned runtime dependencies. A public
fork can be cloned and built without them, can initialize a new local database,
and can run the Hub UI; creating live bots requires the operator to configure
the Vercel resources and credentials described above.

Keep this distinction visible: a passing local test proves a contract at the
tested seam, while a deployed smoke proves that the operator's account, network,
identity and provider configuration work together.
