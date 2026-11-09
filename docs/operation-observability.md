# Critical-flow operation observations

Busy keeps model and tool spans in the existing Eve stream. The Hub now emits a
small metadata-only lifecycle record for the surrounding operations that do not
belong to a chat SSE request:

```json
{"source":"busy.operation","entryPoint":"workflow","flow":"routine","stage":"terminal","outcome":"completed","operationId":"...","durationMs":123}
```

The logger accepts fixed flows (`routine`, `code_task`, `fireside`, `library`,
and `live`), fixed stages, safe IDs, provider/model labels, non-negative
durations and fixed outcomes. Every record carries its actual `operationId` and
the boundary `entryPoint` (`cron`, `workflow`, `http`, or `internal`); the entry
point is never inferred from an ID. Unknown fields and invalid values are
dropped.
Payloads, prompts, transcripts, tool arguments/results, response bodies, signed
URLs and provider error messages are never logged. A logging failure cannot
change leases, delivery state, cancellation, promotion or cleanup.

Coverage currently maps these boundaries:

- A routine occurrence deliberately reuses `routineRuns.id` as the `messages.id`
  and Eve message ID. That same value is the operation ID, while the pinned
  session and delivery IDs remain on the run and are joined by the authenticated
  chat trace endpoint. Dispatch and exact terminal settlement emit bounded
  duration/outcome observations.
- Code-task provider requests emit one model-request observation after the
  task/session profile is validated. The provider and saved model are recorded;
  model-catalog GETs are excluded because they do not submit a generation.
  Generation IDs and usage remain in the existing task projection.
- Fireside dispatch and exact turn settlement use the participant session,
  delivery/message ID and model/provider labels. The archived transcript is not
  copied into observations. The private persisted fireside state also keeps a
  bounded runtime projection for archived turns: actual session, delivery,
  turn, model/provider, call/interaction/run IDs, timestamps, outcomes and
  W3C trace/span IDs when the source supplied them. `eventsTruncated` is
  persisted as `true` when older metadata was evicted at the 5,000-event cap;
  a missing/false value does not imply that the provider emitted every event.
  Interrupted archives use the same projection when a message is written; no
  IDs are invented.
- Library verification and promotion use the bot/file IDs and promotion
  duration/outcome. Content hashes, pathnames and Blob URLs stay out of logs.
- Live session open and control lease calls use the bot and viewer IDs with
  bounded outcome/duration metadata. VM credentials and helper output stay
  private.

These records measure lifecycle and reliability. The existing chat trace remains
the source for exact model/tool spans, and the production performance harness
uses the authenticated UI plus the metadata trace endpoint for first-visible
text and end-to-end checks. Missing model/provider spans stay missing instead of
being guessed.

## Operational questions

- **Routines:** did the scheduled occurrence dispatch, and did its exact
  delivery/turn settle successfully or fail after retry? The operation ID is
  the same ID stored in `routineRuns.id`, `messages.id` and the Eve message;
  session and delivery IDs remain in the persisted run and authenticated chat
  trace timeline.
- **Code tasks:** which saved provider/model profile accepted or rejected the
  model request, and how long did the request boundary take? Catalog lookups do
  not count as model requests. Generation IDs and numeric usage remain in the
  existing task projection.
- **Firesides:** which participant/session turn was dispatched, and did that
  same turn settle before the fireside was archived? Raw prompt content is never
  emitted as an observation. The private `firesides.state.messages[].runtime`
  projection retains bounded participant/session and call rows plus allowlisted
  event metadata, including actual model `runId`, W3C `traceId` and `spanId`
  values when present. Its `eventsTruncated` flag distinguishes the private
  5,000-event cap from a complete captured set. `publicFireside` intentionally
  strips `runtime` from `GET /api/firesides/:id`; there is no public
  runtime-metadata projection.
  Operators read this metadata from server-side persisted-state/admin tooling,
  while `busy.operation` logs provide the lifecycle join IDs. No synthetic trace
  IDs are added.
- **Library and Live:** did file verification/promotion or VM session/control
  complete, remain pending, or fail, and how long did that boundary take? File
  paths, hashes, VM credentials and helper output stay private.

Live heartbeats (`markWatching`) intentionally do not emit one record per
heartbeat: they are high-volume lease refreshes rather than user-visible
operations. Session open, control leases and the eventual stop boundary are the
operational samples; heartbeat coverage remains a documented aggregate-metrics
gap rather than an unbounded trace.
