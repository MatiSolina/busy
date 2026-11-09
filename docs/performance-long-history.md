# Long-history performance workload

The `history-long` evaluator fixture contains one bot with 10,000 turns in its
active session and 64 archived sessions. Archived sessions contain 103 turns
each, approximately 400 facts per session, so the fixture stresses archive
discovery and response serialization without creating an accidental
multi-million-row benchmark. The active session
still exercises the real current-session window and the existing scroll-anchor
checks.

The deterministic seed contains 16,592 messages and 66,368 event facts across
65 sessions. Inserts are batched below PostgreSQL's bind-parameter limit, and
`PERF_SEED_VALIDATE=1` checks those exact counts before a benchmark begins.

Run it with the existing evaluator:

```sh
PERF_WORKLOAD=history-long \
PERF_HISTORY_DIAGNOSTICS=1 \
PERF_HISTORY_EXPERIMENT=bulk-manual \
PERF_VERIFY=1 \
pnpm perf:eval
```

`PERF_HISTORY_EXPERIMENT` is a reporting label with three allowed values:
`bulk-manual`, `paged-manual` and `paged-scroller`. It does not change fixture
data or implementation behavior. Run the three experiments in separate output
directories and keep the same source, evaluator hash, fixture hash, browser,
viewport, CPU throttle, database seed and sample protocol. A label alone is
not evidence that pagination or a scroller was implemented.

The normal paired UI canary uses `paged-manual` for both arms and explicitly
expects one archived session in the first page. It does not infer a bulk
expectation from an `unassigned` label. Older bulk-vs-paged local comparisons
must use `paired.ts` with explicit
`PERF_AB_CONTROL_HISTORY_EXPERIMENT=bulk-manual` and
`PERF_AB_TREATMENT_HISTORY_EXPERIMENT=paged-manual` values.

The primary metric remains `loadReadyMs`. The long-history diagnostics are
reported separately so payload and heap instrumentation cannot become a hidden
winner criterion:

- snapshot request count, response bytes, row count and request duration;
- archive request count, decoded JSON/body bytes (`archiveResponseBytes`, not
  transferred or compressed wire bytes), session count and payload-probe
  duration (`archivePayloadReadyMs`);
- visible archive readiness (`archiveFirstPageReadyMs`) after the newest
  archived-session marker is actually rendered in the selected bot's DOM;
- renderer JavaScript heap used/total bytes after a forced CDP collection after
  snapshot and archive loading; these are not total application RAM;
- a `historyAnchorStable` check from the existing scroll-anchor verification.

`PERF_VERIFY=1` also confirms that the archive button is consumed, the
newest archived session's payload marker is present, and that marker becomes
visible in the selected bot after at most 15 local 20-block reveals. It also
checks that active history can expand without moving its anchor, and that the
existing mobile, reduced-motion, settings and route lifecycle checks remain
valid. Heap and payload values are diagnostic distributions; the payload probe
must not be substituted for visible readiness or used to call an optimization
a winner without the separate paired runtime A/B protocol.

For the bulk-versus-paged experiment, select
`PERF_AB_METRIC=archiveFirstPageReadyMs`. The control label expects 400 active
snapshot rows and 64 archive sessions; the paged labels expect 120 active rows
and one archive session for the first page. Pass those labels separately to
the paired runner with `PERF_AB_CONTROL_HISTORY_EXPERIMENT` and
`PERF_AB_TREATMENT_HISTORY_EXPERIMENT`. The active `loadReadyMs` remains a
separate primary measurement. A latency winner still needs the paired test's
alpha plus both practical thresholds: at least 10% and at least 5 ms.
