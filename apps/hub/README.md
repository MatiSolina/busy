# Busy hub

The hub is a self-hosted Next.js application. It authenticates one owner,
deploys one Vercel project per bot from `templates/bot`, relays chat to each
bot's Eve session, stores stream events and serves the authenticated APIs that
bots call back with their Vercel OIDC identity. Every installation uses the
operator's own Vercel project, database, domains and secrets.

Start with the repository-level [setup skill](../../skills/busy-setup/SKILL.md)
and copy [`.env.example`](.env.example) to `.env.local`. `HUB_URL` must be the
origin where this hub is deployed, `BOTS_DOMAIN` must be a wildcard domain the
operator controls and `MCP_APP_SANDBOX_ORIGIN` must be a separate HTTPS origin
in production.

## Layout

| Path | What lives there |
| --- | --- |
| `app/api/bots/[slug]/…` | Each bot's API, behind the session cookie (`proxy.ts`): messages, answers, stop, live screen, memory, routines, consultations. |
| `app/api/capabilities`, `app/api/skills`, `app/api/mcp` | Skills, plugins and MCP connections, shared by every bot in the app. |
| `app/api/bot/…` | What bots call, authenticated by their OIDC subject (`lib/bot-auth.ts`): directory, files, memory, routines, skills and MCP tokens. |
| `app/api/cron/…` | Static Vercel Schedules (`vercel.json`): hourly event sync, code tasks, embeddings and probes. |
| `app/api/queues/routine-runs` | Consumer of the routines' Vercel Schedules: records and dispatches each run. |
| `lib/chat` | The pure projection from eve events to chat items (`items.ts`), the client store and sending. |
| `lib/routines` | One Vercel Schedule per routine; each execution is sent once, into one session, with a stable id. |
| `workflows/` | Durable Workflow runs: deploys, turn sync, routine follow-up, live screen. |
| `drizzle/` | Numbered SQL migrations. Apply them in order before deploying code that uses them. |

## Scripts

```sh
pnpm dev                      # bundles the bot template, then next dev
pnpm typecheck                # next typegen, then tsc
pnpm lint                     # Ultracite on the hub
pnpm lint:next                # ESLint with the Next.js and React rules
pnpm hash-password            # the single account's password hash
```

For a new empty database, run `NODE_OPTIONS=--env-file=.env.local pnpm db:init`
from this directory. It refuses existing public tables and applies the baseline
and all reviewed migrations transactionally. Use `pnpm db:validate` for an
offline PGlite check. Do not run `drizzle-kit push`
against an existing database: it can remove the RLS and SQL-only constraints
that the reviewed migrations add. See the root README for a copyable local
Postgres example.

Create a private Vercel Blob store in your own account and connect it to the
hub project so `BLOB_READ_WRITE_TOKEN` is available in each environment you
use. Files, library objects and optional desktop release downloads use this
store.

The hub project must be named `busy-hub` because its Vercel OIDC subject is
checked by name. Configure `BOT_BASE_IMAGE` with your own digest-pinned image;
see [the image guide](../../docs/bot-base-image.md).

`setup-secrets.ts` writes only values entered by the operator and generated
random secrets to the linked Vercel project. `gen-hub-key.ts` stores the hub's
private signing key as a sensitive production variable and prints only the
public key. Neither script reads or ships credentials from this repository.

From the repository root, `pnpm build`, `pnpm typecheck` and `pnpm test` are orchestrated by Turborepo. The hub's `build`, `typecheck` and `test` tasks depend on `bundle-template`, which hashes `templates/bot` and restores the generated template JSON. Running `pnpm --filter hub build` directly remains supported through the package's standalone `prebuild` hook. Tests can be scoped with `pnpm turbo run test --filter=hub`.
