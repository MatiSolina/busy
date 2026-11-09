# Testing Busy

Busy separates deterministic repository checks from tests that need a browser,
PostgreSQL server, an Eve provider, Vercel, or an operator-owned bot image. A
fork can run the deterministic suite without credentials. The opt-in suites
exist to verify the boundaries that mocks and PGlite cannot prove.

Test totals vary with platform and enabled optional checks. With the default
local configuration, the 11 real `agent-browser` parser checks and the one
real-PostgreSQL concurrency check remain opt-in. The browser and evaluator
files described below are excluded from the default Vitest collection; they
are distinct from those skipped checks.

## Default checks

From the repository root, install the pinned toolchain first:

```sh
corepack enable
pnpm install --frozen-lockfile
```

The normal test command runs the deterministic suites for the Hub, bot
template, bot-base image and Electron client. These suites use synthetic
fixtures, mocks, PGlite where appropriate, and isolated filesystem/process
fixtures. They do not call Vercel, AI Gateway, a real Eve provider, OAuth
accounts, a live bot, or a production database.

```sh
pnpm test -- --maxWorkers=2
pnpm test:ci-policy
```

The policy tests are plain Node tests for the GitHub task-selection and result
gate. Package-scoped runs are useful while changing one area:

```sh
pnpm --filter hub test -- --maxWorkers=2
pnpm --filter busy-bot test -- --maxWorkers=2
pnpm --filter busy-bot-base-image test -- --maxWorkers=2
pnpm --filter busy-desktop test -- --maxWorkers=2
```

For the full local quality chain, use the same checks expected by the public
CI:

```sh
pnpm quality:doctor
pnpm check:tooling
pnpm check
pnpm lint:next
pnpm typecheck
pnpm test -- --maxWorkers=2
pnpm test:ci-policy
pnpm build
pnpm --filter hub check:runtime
```

## Database checks

`pnpm --filter hub db:validate` creates the baseline and every SQL migration in
an in-memory PGlite database. It needs no database URL, Vercel account, or
provider credential:

```sh
pnpm --filter hub db:validate
```

The real initializer is deliberately separate. It requires the operator's own
empty PostgreSQL database through `.env.local`, refuses a database that already
has public relations, and applies the baseline plus migrations transactionally:

```sh
cd apps/hub
NODE_OPTIONS=--env-file=.env.local pnpm db:init --dry-run
NODE_OPTIONS=--env-file=.env.local pnpm db:init
```

This checks database setup, not Vercel or AI connectivity. The first public
release was manually checked with a real PostgreSQL server, a production Hub
build, fresh-owner login, wrong-password rejection, authenticated inventory,
and protected unauthenticated routes. That was release validation outside
GitHub Actions; it is not currently an automated CI smoke test.

The default suite uses PGlite for most database behavior. The advisory-lock
test is opt-in because only separate PostgreSQL connections prove the locking
contract:

```sh
BUSY_TEST_POSTGRES=1 \
  pnpm exec vitest run apps/hub/lib/mcp/store.concurrency.test.ts --pool=forks
```

This starts and removes a disposable local server. `initdb` and `pg_ctl` must
be available on `PATH`; no remote credentials are needed.

## Tests outside the default Vitest collection

The root `vitest.config.ts` excludes every `*.browser.test.*` and
`*.integration.test.*` file. The public tree currently has four such files:

- `apps/hub/evals/performance/archive-probe.browser.test.ts`
- `apps/hub/evals/performance/native-typing.browser.test.ts`
- `apps/hub/evals/performance/production-visibility.browser.test.ts`
- `apps/hub/evals/performance/evaluator-identity.integration.test.ts`

The first three use local HTTP fixtures and Playwright. They do not need a
provider account, but the Chromium browser must be installed:

```sh
pnpm --filter hub exec playwright install chromium
pnpm exec vitest run --config vitest.browser.config.ts
```

The identity test compares a generated evaluator report with the checked source
and fixture hashes. Supply that report explicitly; it is not a live-provider
test:

```sh
PERF_IDENTITY_REPORT=/absolute/path/to/report.json \
  pnpm exec vitest run --config vitest.identity.config.ts
```

The real `agent-browser` parser suite is also opt-in because the pinned binary
is part of the bot image, not a repository dependency. It runs 11 checks when
`AGENT_BROWSER_PARSER_BIN` is supplied and does not start a browser:

```sh
AGENT_BROWSER_PARSER_BIN=/path/to/agent-browser-binary \
  pnpm exec vitest run images/bot-base/browser-wrapper.parser.test.ts
```

For a Linux binary tested through a container, also set
`AGENT_BROWSER_PARSER_WRAP` and `AGENT_BROWSER_PARSER_TARGET` as documented at
the top of that test file.

## Stream persistence benchmark

The standalone stream-persistence A/B benchmark also requires an explicit
baseline. Set `STREAM_AB_CONTROL_ROOT` to your own local checkout of a different
public commit, with its dependencies installed. It records the actual Git
identity and refuses a comparison with the same commit. From the repository
root:

```sh
STREAM_AB_CONTROL_ROOT=/absolute/path/to/your-baseline \
  pnpm --filter hub exec tsx evals/performance/stream-persistence-ab.ts
```

This optional benchmark needs local PostgreSQL tools and uses disposable
synthetic fixtures. It has no maintainer worktree or private commit default.
See [the performance guide](performance.md) for measurement boundaries.

## Eve evaluations and provider-backed behavior

The deterministic bot contract test runs with `pnpm test`. Eve evaluations are
separate and may use a Decision API model, a linked Vercel project, or a valid
AI Gateway/OIDC credential. Run them from `templates/bot` only when you intend
to use the operator's own resources:

```sh
cd templates/bot
pnpm exec eve eval durable-conversation
pnpm exec eve eval human-in-the-loop
pnpm exec eve eval cancellation
pnpm exec eve eval --strict durable-conversation
```

These evals deliberately avoid real client files, credentials, uploads,
browser accounts and live bot-to-bot content. A provider outage is reported as
provider availability, not treated as a deterministic product assertion. See
[the bot eval notes](../templates/bot/evals/README.md) for the exact auth and
transport requirements.

## GitHub Actions in a fork

`.github/workflows/ultracite.yml` runs on pull requests, pushes to `main`, and
manual dispatch. It installs with the frozen lockfile, runs quality and policy
checks, selects affected Turbo tasks, and runs the selected typecheck, build,
Hub, bot/image and desktop jobs. Shared configuration, `main`, and manual runs
select the complete product coverage. The desktop job uses macOS because the
client and updater contract are macOS-specific.

The affected plan compares a pull request with its public merge base. The
public repository starts as one root commit, so no private repository history
is required or consulted. A documentation-only change may run only lint; a
code change selects the package tasks and declared cross-package contracts.
Keep the task mapping current when adding a workspace or a dependency edge;
unknown packages fail the plan instead of being silently omitted.

`.github/workflows/performance.yml` is intentionally opt-in for pull requests:
the PR needs the `perf` label. A manual run compares a selected baseline with
the candidate and can run the browser measurements and backend contracts. The
manual `baseline_ref` must resolve to a different commit from the candidate;
the default `main` value is rejected when dispatching from that same commit.
On the initial one-commit public repository there is no older public commit to
compare, so wait until a later public commit exists and choose that earlier
commit explicitly. A PR run gets its immutable merge-parent baseline from
GitHub.

`.github/workflows/ci-benchmark.yml` is manual only. It measures dependency
installation and cache behavior on Linux x64, Linux ARM and macOS; it is not a
correctness or deployment test and needs no provider secrets.

## What these checks do not prove

The regular fork CI does not publish a bot image, open a Vercel Sandbox, create
a Vercel project, upload to Blob, call a paid model, complete OAuth, or send a
real bot message. Those operations require the fork owner’s accounts and can
create cost or persistent state. Use a protected manual workflow or a private
staging deployment for those checks; never expose those credentials to a pull
request from a fork.

The desktop test suite exercises the updater and shell contracts. Building the
macOS archive is a separate packaging action:

```sh
pnpm --filter busy-desktop dist
```

The bot-base tests inspect wrappers, image contracts and publishing rules, but
do not build and publish a Docker image in every PR. Follow
[the bot image guide](./bot-base-image.md) before testing a real Sandbox.

For a focused change, run the smallest package suite plus the relevant opt-in
boundary test. Before a release, run the full quality chain, initialize an
isolated database, and perform the operator-owned deployment smoke separately
from deterministic CI results.
