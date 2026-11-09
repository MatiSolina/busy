# Chat observability

Busy keeps the chat's correlation metadata in the existing message and Eve event records. A
message has its client UUID and, after Eve accepts it, a `deliveryId`. The persisted event rows add
the Eve `sessionId`, stream position, event timestamp, `turnId`, model `runId`, tool `callId`, and
the W3C `traceId`/`spanId` carried by `turn.started`.

The authenticated metadata endpoint is:

```text
GET /api/bots/<slug>/messages/<message-uuid>/trace
```

It returns the message status, exact delivery/turn/model/tool/interaction timings when both
endpoints exist, correlation IDs, event counts, and a bounded `missing` list when the stream is
still running or has not been synchronized. Durations have precise names: delivery acceptance is
not turn completion, turn-to-model and model queue durations require their corresponding persisted
endpoints, and turn duration is not TTFT. A missing endpoint never gets a fabricated timestamp.
`complete` also requires delivery consumption and settlement, and terminal events for every
observed model run, tool call and interaction. Missing correlation IDs never create a guessed pair.

For each model attempt, the response may include the model identifier, provider label, queue and
turn-to-model durations, and a numeric usage record. Usage is optional in Eve streams. The top-level
`usage.coverage` reports observed, attributable, duplicate, complete, partial and unknown records;
`usage.totals` is `null` until every observed model attempt has a complete numeric record. A replayed
Only `usage.recorded` facts with `kind: "model"`, an exact `owner.runId` matching a persisted model
run, and no delegated `owner.callId` are attributable to that model run. Delegated tool usage and
ownerless records remain in the observed/unknown coverage counts and are never summed. A replayed
usage event is counted once per unique model run, choosing the most complete record and then the
latest event. If retries reuse one run ID and cannot be assigned to one attempt, usage stays on the
unique `modelRuns` rollup and per-attempt usage remains `null`; aggregate totals become `null` while
that attribution is ambiguous. When attribution is structurally complete but a provider omits one
metric such as cost, the aggregate keeps independently known token/cache fields and leaves only the
missing field `null`, while coverage remains incomplete. Zero is preserved as a real value; missing
or invalid values stay `null`.

Model attempt timing follows Eve's event contract: `model.retried` closes the matching attempt,
while the single terminal `model.settled` closes only the last `model.started` for that run. A final
settlement is never assigned backward to an earlier retry attempt; if an intermediate terminal is
missing, that attempt remains incomplete.

The route is behind Busy's session proxy and repeats the session check in the handler. It also
requires the message UUID to belong to the requested bot slug.

The query is bounded to 1,000 metadata rows and selects JSON keys only. It never selects message
text, prompts, model content, tool arguments, tool results, provider responses, or signed URLs. It
filters by the exact delivery and turn IDs, so concurrent turns and retries in one session do not
appear in another message's timeline. If the bound is reached, the response reports
`event_scan_truncated` through `complete: false`.

Persisted events do not contain token deltas, so this endpoint does not call `content.completed`
TTFT. The production measurement harness observes the first visible assistant text in the browser
and keeps that latency separate from the metadata-only settlement timeline. It never writes the
prompt, delta, model content, tool arguments or results to the report.

Hub logs use the `busy.chat` event with an allowlisted set of IDs, outcomes, counters, durations,
and stable error codes. Each record is a single JSON line. Event labels and outcomes are
allowlisted too; unknown metadata is normalized instead of being echoed. The message POST emits
one completion record. The SSE relay emits one
summary when it closes or a persistence failure occurs; token and delta records are never logged.
Persistence failures log only the bounded error class or SQLSTATE. The existing Eve/Vercel Agent
Runs trace remains the source for model and tool spans; Busy does not add a second telemetry
service.
