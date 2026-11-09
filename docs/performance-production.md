# Production chat measurement

`apps/hub/evals/performance/production.ts` measures the deployed chat with a
real authenticated browser session. It uses the existing page and EventSource,
posts a synthetic marker prompt, observes the rendered bot response, and polls
the metadata-only trace endpoint until the delivery settles.

The harness is deliberately bounded:

- The origin must be the configured `HUB_URL` or an explicit loopback URL for a
  local test.
- Bots must be explicitly allowlisted with `PROD_PERF_BOTS`; use only synthetic
  test bots in an account you control.
- Samples run sequentially, with 1–10 samples per bot.
- `PROD_PERF_STORAGE_STATE` points to an existing Playwright storage-state file;
  the harness never prints or parses its cookies.
- Prompts request an exact synthetic marker and forbid tools, files and external
  actions. The marker is held in memory only and is never written to the report.

The report contains only timing distributions, outcome denominators, provider
and model labels, message/delivery/turn/trace correlation metadata, bounded
stage durations, numeric usage/cache fields when the trace endpoint exposes
them, and safe error codes. It rejects content-shaped keys before writing JSON.
The trace observation duration is a polling bound, not the actual model
settlement latency. `initial` and
`repeat` are page/session phases; they are not claims about a cold or warm
provider cache.

Run after preparing an authenticated state file:

```sh
PROD_PERF_ALLOW_SYNTHETIC_POST=1 \
PROD_PERF_STORAGE_STATE=/private/path/state.json \
PROD_PERF_DEPLOYMENT=<deployment-id> \
PROD_PERF_BOTS=<synthetic-bot-1>,<synthetic-bot-2> \
PROD_PERF_SAMPLES=1 \
PROD_PERF_OUTPUT=.performance/production-control.json \
pnpm -C apps/hub exec tsx evals/performance/production.ts
```

The runner fails closed unless `PROD_PERF_ALLOW_SYNTHETIC_POST=1` is present;
this explicit runtime opt-in gates every synthetic POST.

The output is measurement evidence for a later paired experiment. A fixed
`variant` label and deployment identity are retained, but the harness does not
claim an A/B result: treatment assignment, exposure, denominator, guardrails and
stopping rules must be established before comparing variants causally.

Before a real run, the browser-only path can be exercised without credentials
or model calls:

```sh
pnpm -C apps/hub exec tsx evals/performance/production-browser-fixture.ts
```

This local fixture uses the native EventSource, emits `open`/`session`, renders
a partial assistant response before a simulated ACK, and verifies the exact
final marker with the old 20-block window excluded. It also asserts that
`firstTokenVisibleMs` is recorded from the partial text while `firstVisibleMs`
stays null, and that the first token is visible strictly before the marker.

## Browser visibility milestones

Both milestones use the same clock: `performance.now()` captured when the
observer is armed, immediately before `markSseRequestStart` and the POST. Only
assistant reply blocks (`.prose-chat`) that did not exist when the observer was
armed are considered; user bubbles, reasoning/steps and the previous history
window are excluded. A block counts as visible when the document is visible,
the block has a non-zero box intersecting the viewport, `checkVisibility`
(opacity and CSS visibility) passes, and no ancestor has `display: none`,
`visibility: hidden` or opacity below 0.99. The condition must hold again two
animation frames later; when observation stops, one final synchronous check is
made without the two-frame confirmation.

- `firstTokenVisibleMs` (time to first visible token): elapsed time until the
  first new assistant reply block with any non-empty trimmed text is visible.
  This is the first streamed `content.delta` text the user can read.
- `firstVisibleMs` (fully visible): elapsed time until a new assistant reply
  block whose trimmed text equals the full synthetic marker is visible. Its
  absolute timestamp feeds the SSE fully-visible correlation. Before this
  change, the observer stopped at the first non-empty block, so earlier
  `firstVisibleMs` values could reflect a partial delta.

Both are reported per sample and as p50/p95 distributions globally and per
segment. Only timings are retained; the observed text is compared in the page
and discarded.

After a deployment, usage metadata for an existing report can be enriched
without sending another message:

```sh
PROD_PERF_STORAGE_STATE=/private/path/state.json \
PROD_ENRICH_SOURCE=/private/path/production-control.json \
PROD_PERF_DEPLOYMENT=<deployment-id> \
PROD_ENRICH_OUTPUT=.performance/production-trace-enrichment.json \
pnpm -C apps/hub exec tsx evals/performance/enrich-production-traces.ts
```

This command only performs authenticated GETs to the trace endpoint and keeps
the source report unchanged.

## Next same-clock latency probe (design only)

The next probe is integrated in the runner and local native-SSE fixture, but no
production sample should be started until the measurement window is explicitly
authorized. Its sequence is:

1. Install `installSseLatencyProbe` before navigation and wait for the native
   EventSource `open` and `session` timestamps.
2. Arm the existing visibility observer, then call `markSseRequestStart`
   immediately before the existing bounded POST. The observer now retains both
   the relative first-visible value and an absolute `performance.now()` value.
3. Record only bounded metadata for native `fact`/`progress` events: channel,
   event type, browser monotonic receipt time, `turnId`, `partId` and `runId`.
   The event payload is parsed in place; deltas, values, prompts, arguments and
   results are never stored. The ring reports overflow rather than silently
   claiming complete coverage.
4. After the terminal trace is read, compare each `content.completed`
   public reply value with the in-memory synthetic marker. Discard both texts
   immediately and retain only the exact-match boolean and its unique target
   `partId`; reasoning parts are never selected. Call
   `correlateSseToFullyVisible`
   with the completed trace `turnId`, exact reply `partId` and absolute
   fully-visible timestamp. It reports separate turn-event→fully-visible and
   text-part-event→fully-visible intervals. Retain `measured`, `missing_event`,
   `missing_fully_visible`, `invalid_clock` or `ring_overflow` per interval;
   overflow never becomes a measured latency. The raw same-document
   `timeOrigin`, `open`, `session` and request-start milestones are retained as
   numeric metadata, with `valid`, `missing` or `inconsistent` clock status.
5. Stop the observer and clear its in-page ring in `finally`. Keep the full
   user interval in the report; do not subtract SSE setup time to manufacture a
   performance win. The probe is diagnostic until paired/randomized exposure
   and a larger denominator are authorized.

Trace stage metadata also includes the known optional
`stages.modelAttempts[].queueDurationMs` and `requestedAt` fields. A null value
means that correlation was unavailable for that attempt; it is not evidence
that the endpoint lacks the field.

The visibility result is a fully-visible readiness milestone, not an immediate
DOM paint: the observer requires viewport visibility, opacity at least 0.99 and
two animation frames. Busy's message enter animation is intentionally 120ms,
so a roughly 152–158ms text-part-to-ready interval includes that reveal motion
and must not be called a 152ms CPU rendering stall. Each sample also records a
Chromium CDP `Performance.TaskDuration` delta for the
browser main thread. This is a diagnostic covariate: native SSE callbacks and
fully-visible readiness share the main thread, so it is reported beside the
SSE intervals and never used to subtract time from the user-visible
measurement.

## Scheduled synthetic latency probe (cron)

`GET /api/cron/latency-probe` (every 30 min, `apps/hub/vercel.json`) sends one
synthetic message to each of the four allowlisted QA bots in parallel, without a
browser. It uses the same delivery path as `POST /api/bots/[slug]/messages`
(`lib/chat/deliver.ts`), syncs the bot's stream every 3 s for up to 60 s and
reads the turn with the same loader as the trace endpoint
(`loadChatTrace` in `lib/chat/trace-query.ts`). It catches per-deploy
regressions between manual harness runs.

It is deployed **off**. To enable it, set `LATENCY_PROBE_ENABLED=1` for
Production (`vercel env add LATENCY_PROBE_ENABLED production`) and redeploy;
remove the variable to stop it. The route still requires `CRON_SECRET`. Each
run adds one marker exchange to every QA bot's chat and spends model tokens.

Each sample is one JSON log line (`event: "latency.probe"`, `source:
"busy.chat"`), through the allowlisted `logChatObservation`. It never contains
the prompt or the answer:

| Field | Meaning |
| --- | --- |
| `outcome` | Turn outcome (`completed`, `failed`…), `timeout` if not settled in 60 s, or `not_ready`/`not_found`/`conflict`/`failed` before delivery |
| `ackMs` | Hub insert + delivery to eve (what the POST acknowledgement costs) |
| `admittedLagMs` | Probe start → `delivery.admitted` (hub vs eve clock) |
| `turnStartLagMs` | `delivery.admitted` → `turn.started` |
| `turnToModelMs` / `modelQueueMs` | `turn.started` → first `model.started` / `model.requested` → `model.started` |
| `modelMs` | First model attempt duration |
| `turnMs` | `turn.started` → `turn.settled` |
| `durationMs` | Probe start → `turn.settled` (end-to-end) |
| `inputTokens` / `cachedTokens` / `outputTokens` | Model usage (cache read tokens) |
| `botSlug`, `provider`, `messageId`, `deliveryId`, `sessionId`, `errorCode` | Safe correlation labels |

Read them with `vercel logs -q 'latency.probe'` (from `apps/hub`) and compare
the distribution per `botSlug` before and after a deploy. Negative or missing
intervals are dropped from the line rather than reported as zero; `admittedLagMs`
crosses two clocks, so treat small values as approximate. Use
`/api/bots/<slug>/messages/<messageId>/trace` for the full timeline of an
outlier.
