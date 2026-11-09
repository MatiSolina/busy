# Performance evaluation loop

Busy's performance evaluator measures the application against synthetic data in
an isolated local environment. It is a fixture benchmark, not a claim about
every deployment, provider, network, or user workload.

## Workloads and measurements

The evaluator builds the real Next.js production bundle, authentication proxy,
database queries, React components, styles and panel endpoints. It seeds
synthetic Postgres data and never reads or modifies user conversations.

The default `scale` workload exercises multiple bots, sessions and persisted
events. The `mixed` workload exercises rich content, completed tool calls,
tables, fenced code, links and task lists. Run workloads independently and
retain separate reports.

Each sample uses a fresh browser context, a fixed viewport, CPU throttling and
serial execution. Keep the Node version, browser runtime, fixture, evaluator
and hardware stable between versions. Reports retain every sample, p50, p95,
environment, source identity and the selected primary metric.

Readiness metrics include:

- `loadReadyMs`: selected bot reply, enabled composer, EventSource mount,
  completed reveal and two animation frames.
- `switchReadyMs`: the same content and paint checks after switching bots.
- `typingReadyMs`: native textarea input to paint after two animation frames.
- `streamReadyMs` and `coldStreamReadyMs`: warm and first live synthetic
  replies.
- `panelReadyMs`: Library, Routines and History opening.
- `enterChatRouteReadyMs`, `leaveChatRouteReadyMs` and
  `returnChatRouteReadyMs`: route transitions with content and paint readiness.

Reports also separate server response, script, layout, style and task timings.
These are diagnostic metrics. A browser exception, missing cleanup, incomplete
Markdown render or mismatched sample count invalidates the comparison.

The evaluator uses synthetic provider responses and an EventSource double. It
does not measure model inference, upstream OAuth, Vercel cold starts or a
user's network. Run a separate metadata-only protocol for a deployment you
control if those measurements are needed.

## Run locally

Requirements: the supported Node/pnpm versions, PostgreSQL tools
(`initdb`, `pg_ctl`, `createdb`) on PATH and Playwright Chromium.

```sh
pnpm install --frozen-lockfile
pnpm -C apps/hub exec playwright install chromium

# Build a baseline in an isolated checkout.
git worktree add --detach ../busy-perf-baseline <baseline-commit>
pnpm -C ../busy-perf-baseline install --frozen-lockfile

# Record the baseline with the current evaluator and synthetic fixture.
PERF_APP_DIR=../busy-perf-baseline PERF_RECORD_BASELINE=1 pnpm perf:eval

# Measure the current checkout.
pnpm perf:eval
```

The runner creates a temporary loopback database and production build, uses a
random database password, and removes temporary state on exit. Reports and
bounded logs live under the ignored `.performance/` directory. It refuses
database hosts outside loopback and database names other than `busy_eval`.

Useful controls:

```sh
PERF_BASELINE=/absolute/report.json pnpm perf:eval
PERF_SAMPLES=7 pnpm perf:eval
PERF_WORKLOAD=mixed PERF_BASELINE=.performance/mixed-baseline.json pnpm perf:eval
PERF_EXPECT_MARKDOWN_WORKER=1 pnpm perf:eval
PERF_VERIFY=1 pnpm perf:eval
PERF_PROFILE=/absolute/profile.json pnpm perf:eval
```

Use at least six profiles, with balanced typing-first and streaming-first
samples. Re-record the baseline after changing measurement semantics, fixture
contents or evaluator identity. Do not run builds or other benchmarks
concurrently with timed samples.

The evaluator can launch the Electron entry point with an isolated profile:

```sh
PERF_RUNTIME=electron PERF_APP_DIR=../busy-perf-baseline PERF_RECORD_BASELINE=1 pnpm perf:eval
PERF_RUNTIME=electron PERF_BASELINE=.performance/desktop-baseline.json pnpm perf:eval
```

This measures the renderer inside the desktop shell. It does not measure the
operating system launching a packaged application or exercise account brokers.

## Paired A/B evaluation

`pnpm perf:ab` compares two clean source checkouts with the same synthetic
database, evaluator, browser/runtime settings and session secret. It writes a
predeclared plan containing source, fixture, schema, package, lockfile, runtime,
seed, sample count and balanced block order.

```sh
PERF_CONTROL_DIR=/path/to/worktrees/control \
PERF_TREATMENT_DIR=/path/to/worktrees/treatment \
PERF_AB_BLOCKS=8 \
PERF_AB_SAMPLES_PER_BLOCK=6 \
PERF_AB_SEED=1104 \
PERF_RUNTIME=chromium \
PERF_WORKLOAD=scale \
PERF_AB_OUTPUT_DIR=/tmp/busy-perf-ab-scale \
pnpm perf:ab
```

Both checkouts must be clean and share evaluator, fixture and schema bytes.
The runner builds both variants before timing, keeps failed samples, and
reports paired effects, uncertainty intervals, sign-permutation p-values and
guardrails. A run is inconclusive when a block fails, a primary metric is
missing, a guardrail fails or the uncertainty interval crosses zero. A latency
winner must clear both the declared significance level and the practical
thresholds; do not stop early after a favorable result.

Do not run this evaluator against a deployment. It creates an isolated loopback
server and temporary database; provider and computer calls remain synthetic.

## Iterate and keep the gains

1. Capture a baseline on unchanged source and retain its raw JSON.
2. Form one hypothesis from the slow metric. Profiling is diagnostic and is not
   a final timing result.
3. Add a regression test at the database, store or component seam.
4. Change one cause, build the production bundle and run the evaluator again.
5. Keep the change only when correctness checks pass and the original workload
   improves. Navigation, typing, streaming and panel p95 values must not regress
   beyond the declared guardrail.

The CI performance workflow builds the base and candidate on the same runner,
evaluates them against one synthetic database and uploads both reports and
bounded server logs. Timing from another machine is evidence, not a portable
absolute threshold.

## Implementation boundaries

- Production uses Next.js's Webpack builder and the PostCSS Tailwind pipeline;
  development uses Turbopack with the same CSS pipeline. Browser chunks retain
  the explicit V8 compile hint after minification and source maps, and the
  production build verifies that hint in every browser chunk.
- Startup uses bounded queries for current conversations and consultations.
  Archived sessions load on request and consultation sessions stay excluded.
- Chat routes wait for the requested conversation before revealing the page.
  Bot switches use the client store and retain drafts, scroll position and
  immutable hydration snapshots.
- Leaving or hiding chat closes EventSources and queued retries. Resuming
  reconnects selected or working conversations without duplicate sources.
- The initial view renders a bounded message window. Pagination preserves stable
  keys and the reader's scroll anchor; stored data is never truncated.
- Completed replies use sanitized Markdown trees prepared on the server. Live
  replies use one prewarmed Worker per document with bounded parsing and cleanup
  on unmount; unsupported or failed Workers use the original renderer.
- Frequent panels render an immediate shell. Deferred modules retain their state
  after first opening, including drafts and closing transitions.
