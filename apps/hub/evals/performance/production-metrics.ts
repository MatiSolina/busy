export interface ProductionSample {
  ackWallMs: number | null;
  bot: string;
  cacheReadCount: number | null;
  cacheWriteCount: number | null;
  costUsd: number | null;
  deliveryConsumedMs: number | null;
  deliveryId: string | null;
  deliverySettledMs: number | null;
  deployment: string | null;
  eventScanTruncated: boolean;
  failureCode: string | null;
  failurePhase: string | null;
  firstTokenVisibleMs: number | null;
  firstVisibleMs: number | null;
  inputCount: number | null;
  interactionCount: number;
  mainThreadDiagnosticsStatus: "observed" | "unsupported" | "unavailable";
  mainThreadTaskDurationDeltaMs: number | null;
  messageId: string | null;
  missingStages: string[];
  model: string | null;
  modelRunCount: number;
  outcome: "completed" | "failed" | "timeout";
  outputCount: number | null;
  provider: string | null;
  qualityPassed: boolean;
  repeat: boolean;
  sessionId: string | null;
  spanId: string | null;
  sseClockStatus: "valid" | "missing" | "inconsistent";
  sseDroppedEventCount: number;
  sseExactReplyMatch: boolean;
  sseFirstRelatedTextPartEventType: string | null;
  sseFirstRelatedTurnEventType: string | null;
  sseObservedEventCount: number;
  sseOpenedAtMs: number | null;
  sseOpenToRequestStartMs: number | null;
  sseRequestStartedAtMs: number | null;
  sseSessionAtMs: number | null;
  sseSessionToRequestStartMs: number | null;
  sseTargetPartId: string | null;
  sseTargetTurnId: string | null;
  sseTextPartFullyVisibleStatus:
    | "invalid_clock"
    | "measured"
    | "missing_event"
    | "missing_fully_visible"
    | "ring_overflow";
  sseTextPartToFullyVisibleMs: number | null;
  sseTimeOriginMs: number | null;
  sseTurnFullyVisibleStatus:
    | "invalid_clock"
    | "measured"
    | "missing_event"
    | "missing_fully_visible"
    | "ring_overflow";
  sseTurnToFullyVisibleMs: number | null;
  toolCallCount: number;
  traceComplete: boolean;
  traceCorrelated: boolean;
  traceId: string | null;
  traceIsolated: boolean;
  traceObservationMs: number | null;
  turnDurationMs: number | null;
  turnId: string | null;
  usageCoverage: string | null;
  usageModelRuns: Array<{
    attemptCount: number | null;
    durationMs: number | null;
    modelId: string | null;
    provider: string | null;
    queueDurationMs: number | null;
    requestedAt: string | null;
    runId: string | null;
  }>;
}

export interface Distribution {
  count: number;
  failureRate: number;
  failures: number;
  p50: number | null;
  p95: number | null;
}

export interface UsageMetadata {
  coverage: string | null;
  modelRuns: Array<{
    attemptCount: number | null;
    durationMs: number | null;
    modelId: string | null;
    provider: string | null;
    queueDurationMs: number | null;
    requestedAt: string | null;
    runId: string | null;
  }>;
  totals: {
    cacheReadCount: number | null;
    cacheWriteCount: number | null;
    costUsd: number | null;
    inputCount: number | null;
    outputCount: number | null;
  };
}

export interface TraceIsolationInput {
  callIds: string[];
  interactionIds: string[];
  modelRunIds: string[];
  sessionId: string | null;
}

export interface TracePollFailure {
  failureCode: "trace_incomplete" | "trace_timeout";
  failurePhase: "trace_poll";
  outcome: "failed" | "timeout";
}

export function traceIsolationKeys(trace: TraceIsolationInput): string[] {
  const namespace = trace.sessionId ?? "unknown-session";
  return [
    ...trace.callIds.map((id) => `${namespace}:call:${id}`),
    ...trace.modelRunIds.map((id) => `${namespace}:model:${id}`),
    ...trace.interactionIds.map((id) => `${namespace}:interaction:${id}`),
  ];
}

export function markTraceIsolation(
  trace: TraceIsolationInput,
  previous: Set<string>
): boolean {
  const keys = traceIsolationKeys(trace);
  const isolated = keys.every((key) => !previous.has(key));
  for (const key of keys) {
    previous.add(key);
  }
  return isolated;
}

const SAFE_USAGE_ID = /^[A-Za-z0-9._:/-]{1,128}$/u;
const SAFE_USAGE_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function usageNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usageId(value: unknown): string | null {
  return typeof value === "string" && SAFE_USAGE_ID.test(value) ? value : null;
}

function usageTimestamp(value: unknown): string | null {
  return typeof value === "string" && SAFE_USAGE_TIMESTAMP.test(value)
    ? value
    : null;
}

function coverageFromUsage(value: unknown): string | null {
  if (typeof value === "string" && SAFE_USAGE_ID.test(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const coverage = value as Record<string, unknown>;
  if (coverage.incomplete === false || coverage.complete === true) {
    return "complete";
  }
  if (coverage.incomplete === true || coverage.complete === false) {
    return "partial";
  }
  return null;
}

function modelAttemptsFromTrace(trace: Record<string, unknown>): unknown[] {
  const stages =
    trace.stages && typeof trace.stages === "object"
      ? (trace.stages as Record<string, unknown>)
      : {};
  return Array.isArray(stages.modelAttempts) ? stages.modelAttempts : [];
}

function modelRunMetadata(
  run: unknown,
  attempts: unknown[]
): UsageMetadata["modelRuns"][number] {
  const record = run && typeof run === "object" ? run : {};
  const runId = usageId((record as Record<string, unknown>).runId);
  const attributedAttempts = runId
    ? attempts.filter((attempt) => {
        if (!attempt || typeof attempt !== "object") {
          return false;
        }
        return usageId((attempt as Record<string, unknown>).runId) === runId;
      })
    : [];
  const durationMs =
    attributedAttempts.length === 1
      ? usageNumber(
          (attributedAttempts[0] as Record<string, unknown>).durationMs
        )
      : null;
  const queueDurationMs =
    attributedAttempts.length === 1
      ? usageNumber(
          (attributedAttempts[0] as Record<string, unknown>).queueDurationMs
        )
      : null;
  const requestedAt =
    attributedAttempts.length === 1
      ? usageTimestamp(
          (attributedAttempts[0] as Record<string, unknown>).requestedAt
        )
      : null;
  return {
    attemptCount:
      usageNumber((record as Record<string, unknown>).attemptCount) ??
      (runId && attributedAttempts.length > 0
        ? attributedAttempts.length
        : null),
    durationMs,
    modelId: usageId((record as Record<string, unknown>).modelId),
    provider: usageId((record as Record<string, unknown>).provider),
    queueDurationMs,
    requestedAt,
    runId,
  };
}

/** Accept both the early flat usage shape and the trace.usage.totals shape. */
export function usageMetadataFromTrace(value: unknown): UsageMetadata {
  const trace = value && typeof value === "object" ? value : {};
  const traceRecord = trace as Record<string, unknown>;
  const usage =
    "usage" in traceRecord &&
    traceRecord.usage &&
    typeof traceRecord.usage === "object"
      ? (traceRecord.usage as Record<string, unknown>)
      : {};
  const totals =
    usage.totals && typeof usage.totals === "object"
      ? (usage.totals as Record<string, unknown>)
      : usage;
  const runs = Array.isArray(usage.modelRuns) ? usage.modelRuns : [];
  const attempts = modelAttemptsFromTrace(traceRecord);
  return {
    coverage: coverageFromUsage(usage.coverage),
    modelRuns: runs.map((run) => modelRunMetadata(run, attempts)),
    totals: {
      cacheReadCount: usageNumber(
        totals.cacheReadCount ?? totals.cacheReadTokens
      ),
      cacheWriteCount: usageNumber(
        totals.cacheWriteCount ?? totals.cacheWriteTokens
      ),
      costUsd: usageNumber(totals.costUsd),
      inputCount: usageNumber(totals.inputCount ?? totals.inputTokens),
      outputCount: usageNumber(totals.outputCount ?? totals.outputTokens),
    },
  };
}

/** Mirrors the metadata-only trace route contract without accepting content. */
export function traceCompleteFromMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const trace = value as Record<string, unknown>;
  const eventWindow =
    trace.eventWindow && typeof trace.eventWindow === "object"
      ? (trace.eventWindow as Record<string, unknown>)
      : {};
  const missing = Array.isArray(trace.missing) ? trace.missing : [];
  return (
    trace.complete === true &&
    eventWindow.scanTruncated !== true &&
    missing.length === 0
  );
}

export function postOutcome(status: number): ProductionSample["outcome"] {
  return status === 0 ? "timeout" : "failed";
}

/**
 * Keeps polling deadlines distinct from validation of a completed trace.
 * A completed trace is always handed to the caller for correlation and
 * quality validation, even when that validation later fails.
 */
export function tracePollFailure(
  deadlineExpired: boolean,
  tracePresent: boolean
): TracePollFailure | null {
  if (deadlineExpired) {
    return {
      failureCode: "trace_timeout",
      failurePhase: "trace_poll",
      outcome: "timeout",
    };
  }
  if (!tracePresent) {
    return {
      failureCode: "trace_incomplete",
      failurePhase: "trace_poll",
      outcome: "failed",
    };
  }
  return null;
}

const percentile = (
  values: number[],
  percentileValue: number
): number | null => {
  if (!values.length) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * percentileValue) - 1)
  );
  return sorted[index] ?? null;
};

export function summarize(values: number[], failures = 0): Distribution {
  return {
    count: values.length + failures,
    failureRate:
      values.length + failures === 0
        ? 0
        : failures / (values.length + failures),
    failures,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

export function distributionFor(
  samples: ProductionSample[],
  field:
    | "ackWallMs"
    | "deliveryConsumedMs"
    | "deliverySettledMs"
    | "firstTokenVisibleMs"
    | "firstVisibleMs"
    | "traceObservationMs"
    | "turnDurationMs"
): Distribution {
  const values: number[] = [];
  let failures = 0;
  for (const sample of samples) {
    const value = sample[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      values.push(value);
    } else {
      failures += 1;
    }
  }
  return summarize(values, failures);
}

export function segmentKey(sample: ProductionSample): string {
  return [
    sample.bot,
    sample.provider ?? "unknown-provider",
    sample.model ?? "unknown-model",
    sample.repeat ? "repeat" : "initial",
  ].join("|");
}

export function buildProductionSummary(samples: ProductionSample[]) {
  const segments = new Map<string, ProductionSample[]>();
  for (const sample of samples) {
    const key = segmentKey(sample);
    const group = segments.get(key) ?? [];
    group.push(sample);
    segments.set(key, group);
  }
  return {
    completed: samples.filter((sample) => sample.outcome === "completed")
      .length,
    failed: samples.filter((sample) => sample.outcome === "failed").length,
    latency: {
      ackWallMs: distributionFor(samples, "ackWallMs"),
      deliveryConsumedMs: distributionFor(samples, "deliveryConsumedMs"),
      deliverySettledMs: distributionFor(samples, "deliverySettledMs"),
      firstTokenVisibleMs: distributionFor(samples, "firstTokenVisibleMs"),
      firstVisibleMs: distributionFor(samples, "firstVisibleMs"),
      traceObservationMs: distributionFor(samples, "traceObservationMs"),
      turnDurationMs: distributionFor(samples, "turnDurationMs"),
    },
    samples: samples.length,
    segments: [...segments].map(([segment, group]) => ({
      ackWallMs: distributionFor(group, "ackWallMs"),
      completed: group.filter((sample) => sample.outcome === "completed")
        .length,
      count: group.length,
      deliveryConsumedMs: distributionFor(group, "deliveryConsumedMs"),
      deliverySettledMs: distributionFor(group, "deliverySettledMs"),
      firstTokenVisibleMs: distributionFor(group, "firstTokenVisibleMs"),
      firstVisibleMs: distributionFor(group, "firstVisibleMs"),
      segment,
      traceComplete: group.filter((sample) => sample.traceComplete).length,
      traceObservationMs: distributionFor(group, "traceObservationMs"),
      turnDurationMs: distributionFor(group, "turnDurationMs"),
    })),
    timedOut: samples.filter((sample) => sample.outcome === "timeout").length,
    traceComplete: samples.filter((sample) => sample.traceComplete).length,
  };
}

const SAFE_METADATA_KEYS = new Set([
  "ackWallMs",
  "bot",
  "cacheReadCount",
  "cacheWriteCount",
  "completed",
  "costUsd",
  "count",
  "correction",
  "deliveryConsumedMs",
  "deliveryId",
  "deliverySettledMs",
  "durationMs",
  "deployment",
  "eventScanTruncated",
  "failed",
  "failureCode",
  "failurePhase",
  "failureRate",
  "failures",
  "firstTokenVisibleMs",
  "firstVisibleMs",
  "generatedAt",
  "harness",
  "inputCount",
  "interactionCount",
  "attemptCount",
  "latency",
  "mainThreadDiagnosticsStatus",
  "mainThreadTaskDurationDeltaMs",
  "messageId",
  "missingStages",
  "model",
  "modelRunCount",
  "modelId",
  "opening",
  "origin",
  "outcome",
  "outputCount",
  "phase",
  "p50",
  "p95",
  "provider",
  "qualityPassed",
  "queueDurationMs",
  "repeat",
  "requestedAt",
  "runtime",
  "samples",
  "samplesPerBot",
  "segment",
  "segments",
  "sessionId",
  "sseDroppedEventCount",
  "sseExactReplyMatch",
  "sseFirstRelatedTextPartEventType",
  "sseFirstRelatedTurnEventType",
  "sseClockStatus",
  "sseOpenToRequestStartMs",
  "sseObservedEventCount",
  "sseOpenedAtMs",
  "sseRequestStartedAtMs",
  "sseSessionAtMs",
  "sseSessionToRequestStartMs",
  "sseTargetPartId",
  "sseTargetTurnId",
  "sseTextPartFullyVisibleStatus",
  "sseTextPartToFullyVisibleMs",
  "sseTimeOriginMs",
  "sseTurnFullyVisibleStatus",
  "sseTurnToFullyVisibleMs",
  "spanId",
  "status",
  "summary",
  "timedOut",
  "timeoutMs",
  "toolCallCount",
  "traceCorrelated",
  "traceComplete",
  "traceId",
  "traceIsolated",
  "traceObservationMs",
  "turnDurationMs",
  "turnId",
  "usageCoverage",
  "usageModelRuns",
  "variant",
  "runId",
]);
const NUMERIC_METADATA_KEYS = new Set([
  "ackWallMs",
  "attemptCount",
  "cacheReadCount",
  "cacheWriteCount",
  "completed",
  "costUsd",
  "count",
  "deliveryConsumedMs",
  "deliverySettledMs",
  "durationMs",
  "failed",
  "failureRate",
  "firstTokenVisibleMs",
  "firstVisibleMs",
  "inputCount",
  "interactionCount",
  "modelRunCount",
  "mainThreadTaskDurationDeltaMs",
  "outputCount",
  "p50",
  "p95",
  "queueDurationMs",
  "samples",
  "samplesPerBot",
  "sseDroppedEventCount",
  "sseObservedEventCount",
  "sseOpenedAtMs",
  "sseOpenToRequestStartMs",
  "sseRequestStartedAtMs",
  "sseSessionAtMs",
  "sseSessionToRequestStartMs",
  "sseTextPartToFullyVisibleMs",
  "sseTimeOriginMs",
  "sseTurnToFullyVisibleMs",
  "timedOut",
  "timeoutMs",
  "toolCallCount",
  "traceObservationMs",
  "turnDurationMs",
]);
const SAFE_STRING_METADATA = /^[A-Za-z0-9._:/+|-]{1,256}$/u;
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AssertionError",
  "Error",
  "TimeoutError",
  "TypeError",
]);

/** Reports may contain metadata only; reject accidental content before writing JSON. */
export function assertMetadataOnly(value: unknown, path = "root"): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertMetadataOnly(item, `${path}[${index}]`);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!SAFE_METADATA_KEYS.has(key)) {
      throw new Error("metadata_schema_invalid");
    }
    if (
      NUMERIC_METADATA_KEYS.has(key) &&
      child !== null &&
      typeof child !== "object" &&
      (typeof child !== "number" || !Number.isFinite(child) || child < 0)
    ) {
      throw new Error("metadata_numeric_invalid");
    }
    if (typeof child === "string" && !SAFE_STRING_METADATA.test(child)) {
      throw new Error("metadata_string_invalid");
    }
    assertMetadataOnly(child, `${path}.${key}`);
  }
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
  }
  return "unknown";
}
