---
name: busy-setup
description: Set up a self-hosted Busy hub on Vercel from a public clone or fork, with an empty database, private Blob store, own bot image, domains and first bot.
---

# Set up Busy

Busy runs in the operator's accounts. The Next.js hub deploys each bot as a
separate Vercel project using Eve and Vercel Sandbox. The repository includes
all source, bot instructions and built-in skills; each installation supplies
its own credentials and infrastructure.

Work in order. Run authorized commands where possible. Ask only for unavailable
accounts, credentials or domains. Never put secrets in chat, command arguments
or commits. Use hidden prompts or the provider's UI. Do not source `.env.local`
in a shell: password hashes contain literal `$` separators. Load it through
Node's `--env-file` instead.

## Prerequisites

- Node.js 24.15 or later, Corepack and the pnpm version pinned in `package.json`.
- A Vercel team with access to Sandbox, Queues, Schedules, Blob, Container
  Registry and AI Gateway. These services have their own limits and costs.
- An empty Postgres database, such as one provisioned through Vercel Marketplace.
- Docker with Buildx to publish the bot computer image.
- An HTTPS hub domain, a wildcard bot domain and a separate HTTPS origin for
  MCP Apps. The two HTTPS origins must be different.

## 1. Clone and install

```sh
git clone https://github.com/MatiSolina/busy.git
cd busy
corepack enable
pnpm install --frozen-lockfile
```

Fork first if the operator wants automatic Git deployments or changes to the
source. Use the root README's local setup for a UI-only development instance.
Running bots requires the Vercel resources below.

## 2. Create and link the hub

Import the fork into Vercel. Name the project **busy-hub**: the development
relay validates that name in its OIDC subject. Set the root directory to
`apps/hub` and enable access to source files outside that root so the build can
bundle `templates/bot`. Keep the repository's build command and Node.js 24.

Then link the clone to that project, choosing the operator's own team:

```sh
cd apps/hub
pnpm exec vercel login
pnpm exec vercel link
```

Record the team's ID and slug for `VERCEL_TEAM_ID` and `VERCEL_TEAM_SLUG`.
Inspect `.vercel/project.json` and the selected team before writing variables;
never reuse another installation's project link.

## 3. Provision Postgres and private Blob

Create a new empty Postgres database and connect it to the hub. Configure
`DATABASE_URL` for runtime and `DATABASE_URL_UNPOOLED` for direct migrations.
Create a **private Vercel Blob store** in the same account and connect it to the
hub so `BLOB_READ_WRITE_TOKEN` is supplied. The hub uses it for chat files,
library objects and optional desktop release archives.

Pull the environment into the ignored local file and initialize the database:

```sh
pnpm exec vercel env pull .env.local --environment=development --yes
NODE_OPTIONS=--env-file=.env.local pnpm db:init --dry-run
NODE_OPTIONS=--env-file=.env.local pnpm db:init
```

Use the connection string for the intended new database. If production uses a
separate database, initialize that empty database too, loading its connection
string privately. Do not assume a development database initializes production.

`db:init` refuses existing public tables/views and applies the baseline and all
SQL migrations transactionally. It handles plain Postgres without Supabase's
Data API roles. `pnpm db:validate` validates the same baseline and migrations in
an offline PGlite database. Never use `drizzle-kit push` on an existing
installation: it can remove RLS and SQL-only constraints. Apply reviewed pending
SQL migrations for upgrades instead.

## 4. Store account and signing secrets

From `apps/hub`:

```sh
pnpm exec node scripts/setup-secrets.ts
pnpm exec node scripts/gen-hub-key.ts
```

The first script asks the operator for a username, password of at least 12
characters and a Vercel token scoped to their team. It writes the password hash,
random per-environment session secrets, production cron secret, Vercel token
and optional Token Pass key into the linked project. The signing-key script
creates a sensitive production `HUB_SIGNING_KEY` and prints only its public
half. It refuses to overwrite an existing key. Never copy the production
signing key into a development file or another installation.

## 5. Publish the bot computer image

Follow [the image guide](../../docs/bot-base-image.md). From the repository root,
log in to the intended Container Registry and build/push the included image
using an explicit repository owned by that team. Set `BOT_BASE_IMAGE` on the hub
to the resulting digest-pinned reference. Grant the bot projects read access
as described by the registry for that team. The hub forwards the image setting
to every bot; it has no fallback to the maintainer's private image.

## 6. Set the remaining production variables

Use `pnpm exec vercel env add NAME production` to enter values interactively.
Add development values separately when local work needs them. The full variable
reference is [apps/hub/.env.example](../../apps/hub/.env.example).

| Variable | Meaning |
| --- | --- |
| `HUB_URL` | Hub HTTPS origin, for example `https://busy.example.com` |
| `BOTS_DOMAIN` | Wildcard bot domain, for example `bots.example.com` |
| `VERCEL_TEAM_ID` / `VERCEL_TEAM_SLUG` | Operator's team ID and slug |
| `BOT_BASE_IMAGE` | Own image pinned to `@sha256:` plus its digest |
| `DATABASE_URL` | Own runtime Postgres connection |
| `BLOB_READ_WRITE_TOKEN` | Own private Blob store credential |
| `MCP_APP_SANDBOX_ORIGIN` | A different HTTPS origin serving `/mcp-app-sandbox` from this app |

Make the second sandbox domain an alias of the hub deployment so it serves the
sandbox route on a different origin. Add the hub domain in Vercel and configure
the bots' wildcard domain for the operator's team. Check DNS and ownership
before creating bots.

The default model path uses Vercel AI Gateway with project OIDC. Enable billing
and access in that account. Optional Sign in with Vercel uses the operator's
own `VERCEL_APP_CLIENT_ID`, `VERCEL_APP_CLIENT_SECRET` and `BUSY_VERCEL_USERS`.
Without it, use the username and password configured above. Connect any
additional providers through the hub with the operator's own accounts.

## 7. Deploy and create the first bot

Deploy the configured hub from the linked repository and confirm the deployment
is Ready. For a CLI deployment from the complete monorepo, use the linked hub
project and its configured root directory:

```sh
pnpm exec vercel deploy --prod
```

Open `HUB_URL`, sign in, then choose **Create bot**. The hub deploys the bot to a
new project in the operator's team. Wait for Ready and send a message. Verify
the response and computer rather than treating a completed build as a runtime
check. No end-to-end bot run is implied by the repository's offline tests.

## Desktop client

The source client can target the operator's hub with `BUSY_URL`. Follow
[docs/desktop.md](../../docs/desktop.md) to run it or build the macOS archive.
The hub's `/install` route works only after the operator has published their
archive and configured `BUSY_APP_VERSION` and `BUSY_APP_SHA256`; it is optional
for web use.

## Troubleshooting

- Run `pnpm doctor:vercel` from the repository root and inspect `checks[].status`.
- Missing environment variables identify the configuration step to revisit.
- Missing `BOT_BASE_IMAGE` requires publishing the team's own image first.
- File/library failures need a private Blob store and its own token.
- Database errors need the intended database and successful `db:init`.
- Inspect the bot project's deployment log for a failed build or prewarm.
- Never enable `BUSY_DEV_NO_AUTH=1` on a public deployment.
