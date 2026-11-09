type SafeValue = boolean | number | string | null;
type SafeFields = Record<string, SafeValue | undefined>;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const SAFE_TEXT = /^[A-Za-z0-9._:-]{1,128}$/u;
const SAFE_MODEL_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;
const MAX_USAGE_COUNT = 1_000_000_000_000;
const MAX_USAGE_COST_USD = 1_000_000_000;
const EVENT_TYPES = new Set([
  "call.requested",
  "call.settled",
  "call.started",
  "content.completed",
  "delivery.admitted",
  "delivery.consumed",
  "delivery.settled",
  "interaction.opened",
  "interaction.settled",
  "model.requested",
  "model.retried",
  "model.settled",
  "model.started",
  "response.admitted",
  "response.settled",
  "response.submitted",
  "session.started",
  "turn.paused",
  "turn.settled",
  "turn.started",
  "usage.recorded",
]);
const OUTCOMES = new Set([
  "accepted",
  "already_accepted",
  "applied",
  "awaiting-input",
  "cancelled",
  "closed",
  "completed",
  "conflict",
  "consultation_failed",
  "failed",
  "handled",
  "interrupted",
  "invalid_data",
  "not_found",
  "not_ready",
  "pending",
  "persistence_failed",
  "rejected",
  "running",
  "skipped",
  "success",
  "suspended",
  "timeout",
  "unknown",
]);
const TRACE_ID = /^[0-9a-f]{32}$/iu;
const SPAN_ID = /^[0-9a-f]{16}$/iu;
const SAFE_ERROR_CODES = new Set([
  "AbortError",
  "ClientError",
  "DrizzleQueryError",
  "Error",
  "FetchError",
  "PostgresError",
  "TimeoutError",
  "TypeError",
  "message_delivery_failed",
  "unknown",
]);
const OBSERVATION_EVENTS = new Set([
  "ai.response",
  "chat.persistence",
  "chat.rum",
  "chat.stream",
  "latency.probe",
  "message.fast",
  "message.post",
  "message.warm",
]);
const SAFE_KEYS = new Set([
  "ackMs",
  "acked",
  "admittedLagMs",
  "modelMs",
  "modelQueueMs",
  "turnMs",
  "turnStartLagMs",
  "turnToModelMs",
  "botSlug",
  "cacheCanary",
  "cachedTokens",
  "cacheParts",
  "callId",
  "childSessionId",
  "decision",
  "deliveryId",
  "durationMs",
  "escalated",
  "errorCode",
  "factsForwarded",
  "firstChunkMs",
  "headDigest",
  "historyDigest",
  "inputBytes",
  "inputItems",
  "instructionsBytes",
  "toolCount",
  "toolsBytes",
  "firstLine",
  "firstRecordMs",
  "inputTokens",
  "outputTokens",
  "provider",
  "providerErrorCode",
  "providerErrorParam",
  "reasoningTokens",
  "status",
  "streamMs",
  "upstreamMs",
  "turnStartedAt",
  "turnStartedLagMs",
  "lastLine",
  "messageId",
  "maxQueuedBytes",
  "maxQueuedRows",
  "nextLine",
  "outcome",
  "parentSessionId",
  "oversizedRecordBytes",
  "oversizedRecordCount",
  "pressureWaits",
  "recordsSeen",
  "requestId",
  "requestedTier",
  "rowCount",
  "saveCalls",
  "saveDurationMs",
  "sendAckMs",
  "serviceTier",
  "sessionId",
  "totalMs",
  "ttftMs",
]);

/** Headers accepted into logs. Never fall back to a body, URL, or exception message. */
export function requestIdOf(req: Request): string | undefined {
  const value =
    req.headers.get("x-request-id") ?? req.headers.get("x-vercel-id");
  return value && SAFE_REQUEST_ID.test(value) ? value : undefined;
}

/** A bounded, data-free error label for runtime logs. */
export function errorCodeOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && SQLSTATE.test(code)) {
      return code;
    }
  }
  return error instanceof Error && SAFE_ERROR_CODES.has(error.name)
    ? error.name
    : "unknown";
}

// Per-stage durations from lib/trace.ts stageFields(): numbers only.
const STAGE_KEY = /^stage[A-Z][A-Za-z0-9]{0,62}Ms$/u;

function safeLogValue(key: string, value: SafeValue): SafeValue | undefined {
  if (STAGE_KEY.test(key)) {
    return safeStageValue(value);
  }
  return safeFieldValue(key, value);
}

function safeStageValue(value: SafeValue): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function safeFieldValue(key: string, value: SafeValue): SafeValue | undefined {
  if (!SAFE_KEYS.has(key)) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    let valid: boolean;
    if (key === "errorCode") {
      valid = SQLSTATE.test(value) || SAFE_ERROR_CODES.has(value);
    } else if (key === "outcome") {
      valid = OUTCOMES.has(value);
    } else {
      valid = (key === "requestId" ? SAFE_REQUEST_ID : SAFE_TEXT).test(value);
    }
    return valid ? value : undefined;
  }
  return typeof value === "boolean" || value === null ? value : undefined;
}

/**
 * Structured chat logs are deliberately allowlisted. Do not pass Error objects,
 * request bodies, provider responses, prompts, tool arguments, or tool outputs.
 */
export function logChatObservation(
  event: string,
  fields: SafeFields = {}
): void {
  if (!OBSERVATION_EVENTS.has(event)) {
    return;
  }
  const safe: Record<string, SafeValue> = { event, source: "busy.chat" };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) {
      const safeValue = safeLogValue(key, value);
      if (safeValue !== undefined) {
        safe[key] = safeValue;
      }
    }
  }
  console.info(JSON.stringify(safe));
}

export interface ChatTraceEvent {
  at: Date | string | null;
  attempt: number | null;
  callId: string | null;
  deliveryId: string | null;
  errorCode: string | null;
  index: number;
  interactionId: string | null;
  line: number;
  modelId: string | null;
  outcome: string | null;
  provider: string | null;
  runId: string | null;
  spanId: string | null;
  traceId: string | null;
  turnId: string | null;
  type: string;
  usageCacheReadText?: string | null;
  usageCacheWriteText?: string | null;
  usageCostText?: string | null;
  usageInputText?: string | null;
  usageKind?: string | null;
  usageOutputText?: string | null;
  usageOwnerCallId?: string | null;
  usageOwnerRunId?: string | null;
}

export interface ChatTraceMessage {
  botSlug: string;
  createdAt: Date | string | null;
  deliveryId: string | null;
  id: string;
  status: string;
}

interface TimedStage {
  durationMs: number | null;
  endAt: string | null;
  outcome: string | null;
  startAt: string | null;
}

interface TraceModelAttempt extends TimedStage {
  attempt: number | null;
  modelId: string | null;
  provider: string | null;
  queueDurationMs: number | null;
  requestedAt: string | null;
  retryAt: string | null;
  runId: string | null;
  turnToModelMs: number | null;
  usage: ChatTraceUsage | null;
  usageComplete: boolean;
  usageRecordCount: number;
}

export interface ChatTraceUsage {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface ChatTraceUsageCoverage {
  ambiguousRuns: number;
  attemptsWithoutUsage: number;
  attemptsWithUsage: number;
  attributableRecords: number;
  completeRecords: number;
  duplicateRecords: number;
  incomplete: boolean;
  observedRecords: number;
  partialRecords: number;
  uniqueRuns: number;
  unknownRecords: number;
}

export interface ChatTraceModelUsage {
  attemptCount: number;
  modelId: string | null;
  provider: string | null;
  runId: string;
  usage: ChatTraceUsage | null;
  usageComplete: boolean;
  usageRecordCount: number;
}

const timeMs = (value: Date | string | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value: Date | string | null | undefined): string | null => {
  const parsed = timeMs(value);
  return parsed === null ? null : new Date(parsed).toISOString();
};

const durationMs = (
  start: Date | string | null | undefined,
  end: Date | string | null | undefined
): number | null => {
  const started = timeMs(start);
  const ended = timeMs(end);
  if (started === null || ended === null || ended < started) {
    return null;
  }
  return ended - started;
};

const first = (rows: ChatTraceEvent[], type: string) =>
  rows.find((row) => row.type === type);

const compact = (values: Array<string | null>): string[] =>
  values.filter((value): value is string => value !== null);

const metadataId = (value: string | null): string | null =>
  value && SAFE_TEXT.test(value) ? value : null;

const metadataOutcome = (value: string | null): string | null =>
  value && OUTCOMES.has(value) ? value : null;

const metadataTraceId = (value: string | null): string | null =>
  value && TRACE_ID.test(value) ? value : null;

const metadataSpanId = (value: string | null): string | null =>
  value && SPAN_ID.test(value) ? value : null;

const metadataModelLabel = (value: string | null): string | null =>
  value && SAFE_MODEL_LABEL.test(value) ? value : null;

function usageNumber(
  value: string | null | undefined,
  maximum: number
): number | null {
  if (value === null || value === undefined || value.trim() === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum
    ? parsed
    : null;
}

function usageFromRow(row: ChatTraceEvent): ChatTraceUsage {
  return {
    cacheReadTokens: usageNumber(row.usageCacheReadText, MAX_USAGE_COUNT),
    cacheWriteTokens: usageNumber(row.usageCacheWriteText, MAX_USAGE_COUNT),
    costUsd: usageNumber(row.usageCostText, MAX_USAGE_COST_USD),
    inputTokens: usageNumber(row.usageInputText, MAX_USAGE_COUNT),
    outputTokens: usageNumber(row.usageOutputText, MAX_USAGE_COUNT),
  };
}

const USAGE_KEYS: Array<keyof ChatTraceUsage> = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
];

function usageState(usage: ChatTraceUsage): "complete" | "partial" | "unknown" {
  const known = USAGE_KEYS.filter((key) => usage[key] !== null).length;
  if (known === USAGE_KEYS.length) {
    return "complete";
  }
  return known > 0 ? "partial" : "unknown";
}

function aggregateUsageField(
  runs: ChatTraceModelUsage[],
  key: keyof ChatTraceUsage
): number | null {
  if (!runs.every((run) => run.usage !== null && run.usage[key] !== null)) {
    return null;
  }
  return runs.reduce((total, run) => total + (run.usage?.[key] ?? 0), 0);
}

function aggregateUsage(runs: ChatTraceModelUsage[]): ChatTraceUsage | null {
  const totals: ChatTraceUsage = {
    cacheReadTokens: aggregateUsageField(runs, "cacheReadTokens"),
    cacheWriteTokens: aggregateUsageField(runs, "cacheWriteTokens"),
    costUsd: aggregateUsageField(runs, "costUsd"),
    inputTokens: aggregateUsageField(runs, "inputTokens"),
    outputTokens: aggregateUsageField(runs, "outputTokens"),
  };
  return USAGE_KEYS.some((key) => totals[key] !== null) ? totals : null;
}

function completeUsage(usage: ChatTraceUsage | null): usage is ChatTraceUsage {
  return Boolean(usage && USAGE_KEYS.every((key) => usage[key] !== null));
}

function canonicalUsage(
  rows: ChatTraceEvent[],
  runId: string | null
): { usage: ChatTraceUsage | null; recordCount: number } {
  if (runId === null) {
    return { recordCount: 0, usage: null };
  }
  const usageRows = rows.filter(
    (candidate) =>
      candidate.type === "usage.recorded" &&
      candidate.usageKind === "model" &&
      candidate.usageOwnerCallId === null &&
      candidate.usageOwnerRunId === runId
  );
  const [canonicalUsageRow] = usageRows
    .map((candidate) => ({ candidate, usage: usageFromRow(candidate) }))
    .sort((left, right) => {
      const knownDelta =
        USAGE_KEYS.filter((key) => right.usage[key] !== null).length -
        USAGE_KEYS.filter((key) => left.usage[key] !== null).length;
      if (knownDelta !== 0) {
        return knownDelta;
      }
      return (
        right.candidate.line - left.candidate.line ||
        right.candidate.index - left.candidate.index
      );
    });
  return {
    recordCount: usageRows.length,
    usage: canonicalUsageRow?.usage ?? null,
  };
}

function usageCoverage(
  rows: ChatTraceEvent[],
  modelAttempts: Array<{
    modelId: string | null;
    provider: string | null;
    runId: string | null;
    usage: ChatTraceUsage | null;
    usageComplete: boolean;
    usageRecordCount: number;
  }>,
  windowIncomplete = false
): {
  coverage: ChatTraceUsageCoverage;
  modelRuns: ChatTraceModelUsage[];
  totals: ChatTraceUsage | null;
} {
  const usageRows = rows.filter((row) => row.type === "usage.recorded");
  const modelRunIds = new Set(
    modelAttempts
      .map((attempt) => attempt.runId)
      .filter((runId): runId is string => runId !== null)
  );
  const usageByRun = new Map<string, ChatTraceUsage[]>();
  for (const row of usageRows) {
    if (
      row.usageKind !== "model" ||
      !row.usageOwnerRunId ||
      row.usageOwnerCallId !== null ||
      !modelRunIds.has(row.usageOwnerRunId)
    ) {
      continue;
    }
    const list = usageByRun.get(row.usageOwnerRunId) ?? [];
    list.push(usageFromRow(row));
    usageByRun.set(row.usageOwnerRunId, list);
  }
  const attemptsByRun = new Map<string, typeof modelAttempts>();
  for (const attempt of modelAttempts) {
    if (!attempt.runId) {
      continue;
    }
    const list = attemptsByRun.get(attempt.runId) ?? [];
    list.push(attempt);
    attemptsByRun.set(attempt.runId, list);
  }
  const modelRuns = [...attemptsByRun.entries()].map(([runId, attempts]) => {
    const { recordCount: usageRecordCount, usage } = canonicalUsage(
      rows,
      runId
    );
    return {
      attemptCount: attempts.length,
      modelId: attempts.at(-1)?.modelId ?? null,
      provider: attempts.at(-1)?.provider ?? null,
      runId,
      usage,
      usageComplete: completeUsage(usage),
      usageRecordCount,
    };
  });
  const attemptsWithUsage = modelAttempts.filter((attempt) => {
    if (
      !attempt.runId ||
      (attemptsByRun.get(attempt.runId)?.length ?? 0) !== 1
    ) {
      return false;
    }
    return (usageByRun.get(attempt.runId)?.length ?? 0) > 0;
  }).length;
  const completeRecords = [...usageByRun.values()].filter((records) =>
    records.some((usage) => usageState(usage) === "complete")
  ).length;
  const partialRecords = [...usageByRun.values()].filter((records) =>
    records.some((usage) => usageState(usage) === "partial")
  ).length;
  const unknownRecords = usageRows.filter((row) => {
    const ownerRunId = row.usageOwnerRunId ?? null;
    return (
      row.usageKind !== "model" ||
      row.usageOwnerCallId !== null ||
      ownerRunId === null ||
      !modelRunIds.has(ownerRunId) ||
      usageState(usageFromRow(row)) === "unknown"
    );
  }).length;
  const attributableRecords = usageRows.filter((row) => {
    const ownerRunId = row.usageOwnerRunId ?? null;
    return (
      row.usageKind === "model" &&
      row.usageOwnerCallId === null &&
      ownerRunId !== null &&
      modelRunIds.has(ownerRunId)
    );
  }).length;
  const duplicateRecords = [...usageByRun.values()].reduce(
    (total, records) => total + Math.max(0, records.length - 1),
    0
  );
  const ambiguousRuns = modelRuns.filter((run) => run.attemptCount > 1).length;
  const structurallyComplete =
    modelAttempts.length > 0 &&
    modelAttempts.every((attempt) => attempt.runId !== null) &&
    ambiguousRuns === 0 &&
    modelRuns.length === modelAttempts.length;
  const complete =
    structurallyComplete && modelRuns.every((run) => run.usageComplete);
  const totals =
    structurallyComplete && !windowIncomplete
      ? aggregateUsage(modelRuns)
      : null;
  return {
    coverage: {
      ambiguousRuns,
      attemptsWithoutUsage: Math.max(
        0,
        modelAttempts.length - attemptsWithUsage
      ),
      attemptsWithUsage,
      attributableRecords,
      completeRecords,
      duplicateRecords,
      incomplete: windowIncomplete || !complete,
      observedRecords: usageRows.length,
      partialRecords,
      uniqueRuns: modelRuns.length,
      unknownRecords,
    },
    modelRuns,
    totals,
  };
}

function pairStages(
  rows: ChatTraceEvent[],
  startType: string,
  settledType: string,
  key: (row: ChatTraceEvent) => string | null
): Array<{ start: ChatTraceEvent; end?: ChatTraceEvent }> {
  const used = new Set<number>();
  return rows
    .filter((row) => row.type === startType)
    .map((start) => {
      const startKey = key(start);
      if (startKey === null) {
        return { start };
      }
      const endIndex = rows.findIndex(
        (candidate, index) =>
          candidate.type === settledType &&
          !used.has(index) &&
          key(candidate) === startKey &&
          (timeMs(candidate.at) ?? Number.POSITIVE_INFINITY) >=
            (timeMs(start.at) ?? 0)
      );
      if (endIndex === -1) {
        return { start };
      }
      used.add(endIndex);
      return { end: rows[endIndex], start };
    });
}

function eventAfter(candidate: ChatTraceEvent, start: ChatTraceEvent): boolean {
  return (
    candidate.line > start.line ||
    (candidate.line === start.line && candidate.index > start.index)
  );
}

function pairModelAttempts(
  rows: ChatTraceEvent[]
): Array<{ start: ChatTraceEvent; end?: ChatTraceEvent }> {
  const starts = rows.filter((row) => row.type === "model.started");
  return starts.map((start) => {
    if (start.runId === null) {
      return { start };
    }
    const newerAttempt = starts.find(
      (candidate) =>
        candidate.runId === start.runId && eventAfter(candidate, start)
    );
    const inAttempt = (candidate: ChatTraceEvent) =>
      eventAfter(candidate, start) &&
      (!newerAttempt || eventAfter(newerAttempt, candidate));
    const retry = rows.find(
      (candidate) =>
        candidate.type === "model.retried" &&
        candidate.runId === start.runId &&
        candidate.attempt === start.attempt &&
        inAttempt(candidate)
    );
    if (retry) {
      return { end: retry, start };
    }
    if (newerAttempt) {
      return { start };
    }
    const settled = rows.find(
      (candidate) =>
        candidate.type === "model.settled" &&
        candidate.runId === start.runId &&
        inAttempt(candidate)
    );
    return settled ? { end: settled, start } : { start };
  });
}

function timedStage(start: ChatTraceEvent, end?: ChatTraceEvent): TimedStage {
  return {
    durationMs: durationMs(start.at, end?.at),
    endAt: iso(end?.at),
    outcome: end?.outcome ?? null,
    startAt: iso(start.at),
  };
}

function missingDeliveryEvents(
  deliveryId: string | null,
  rows: ChatTraceEvent[]
): string[] {
  if (!deliveryId) {
    return ["delivery_id"];
  }
  return ["delivery.admitted", "delivery.consumed", "delivery.settled"].filter(
    (type) => !rows.some((row) => row.type === type)
  );
}

function normalizeTraceEvent(row: ChatTraceEvent): ChatTraceEvent {
  const errorCode =
    row.errorCode !== null &&
    (SQLSTATE.test(row.errorCode) || SAFE_ERROR_CODES.has(row.errorCode))
      ? row.errorCode
      : null;
  return {
    ...row,
    attempt:
      Number.isInteger(row.attempt) && (row.attempt as number) >= 0
        ? row.attempt
        : null,
    callId: metadataId(row.callId),
    deliveryId: metadataId(row.deliveryId),
    errorCode,
    interactionId: metadataId(row.interactionId),
    modelId: metadataModelLabel(row.modelId),
    outcome: metadataOutcome(row.outcome),
    provider: metadataModelLabel(row.provider),
    runId: metadataId(row.runId),
    spanId: metadataSpanId(row.spanId),
    traceId: metadataTraceId(row.traceId),
    turnId: metadataId(row.turnId),
    type: EVENT_TYPES.has(row.type) ? row.type : "unknown",
    usageKind: metadataModelLabel(row.usageKind ?? null),
    // A malformed call owner is still present: dropping it to null would
    // incorrectly promote delegated usage to the enclosing model run.
    usageOwnerCallId:
      row.usageOwnerCallId === null || row.usageOwnerCallId === undefined
        ? null
        : (metadataId(row.usageOwnerCallId) ?? ""),
    usageOwnerRunId: metadataId(row.usageOwnerRunId ?? null),
  };
}

function attributeModelAttempts(
  attempts: TraceModelAttempt[]
): TraceModelAttempt[] {
  const counts = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.runId) {
      counts.set(attempt.runId, (counts.get(attempt.runId) ?? 0) + 1);
    }
  }
  return attempts.map((attempt) => {
    const uniquelyAttributed =
      attempt.runId !== null && counts.get(attempt.runId) === 1;
    return {
      ...attempt,
      usage: uniquelyAttributed ? attempt.usage : null,
      usageComplete: uniquelyAttributed && completeUsage(attempt.usage),
    };
  });
}

function addMissingModelSettlement(
  missing: string[],
  rows: ChatTraceEvent[],
  attempts: TraceModelAttempt[]
): void {
  const hasUnsettledModelRun =
    attempts.length > 0 &&
    attempts.some(
      (attempt) =>
        attempt.runId === null ||
        !rows.some(
          (row) => row.type === "model.settled" && row.runId === attempt.runId
        )
    );
  if (hasUnsettledModelRun && !missing.includes("model.settled")) {
    missing.push("model.settled");
  }
}

/**
 * Folds only metadata columns from persisted Eve events. It deliberately never
 * accepts or returns the JSON payload, so prompts, arguments and tool results
 * cannot leak through the diagnostic endpoint.
 */
export function buildChatTraceTimeline(
  message: ChatTraceMessage,
  sessionId: string | null,
  rows: ChatTraceEvent[],
  scanTruncated = false
) {
  const normalizedRows = rows.map(normalizeTraceEvent);
  const { deliveryId } = message;
  const deliveryRows = deliveryId
    ? normalizedRows.filter((row) => row.deliveryId === deliveryId)
    : [];
  const missing = missingDeliveryEvents(deliveryId, deliveryRows);
  const admitted = first(deliveryRows, "delivery.admitted");
  const consumed = first(deliveryRows, "delivery.consumed");
  const settled = first(deliveryRows, "delivery.settled");

  const turnId =
    consumed?.turnId ?? settled?.turnId ?? admitted?.turnId ?? null;
  if (deliveryId && admitted && !turnId) {
    missing.push("turn_id");
  }
  const scopedRows = normalizedRows.filter(
    (row) =>
      (deliveryId !== null && row.deliveryId === deliveryId) ||
      (turnId !== null && row.turnId === turnId)
  );
  const turnStarted = first(scopedRows, "turn.started");
  const turnSettled = first(scopedRows, "turn.settled");
  if (turnId && !turnStarted) {
    missing.push("turn.started");
  }
  if (turnId && !turnSettled) {
    missing.push("turn.settled");
  }

  const rawModelAttempts: TraceModelAttempt[] = pairModelAttempts(
    scopedRows
  ).map(({ end, start }) => {
    const hasPriorAttempt = scopedRows.some(
      (candidate) =>
        candidate.type === "model.started" &&
        candidate.runId === start.runId &&
        eventAfter(start, candidate)
    );
    const requested =
      start.runId === null || hasPriorAttempt
        ? undefined
        : scopedRows
            .filter(
              (candidate) =>
                candidate.type === "model.requested" &&
                candidate.runId === start.runId &&
                !eventAfter(candidate, start)
            )
            .at(-1);
    const { recordCount, usage } = canonicalUsage(scopedRows, start.runId);
    return {
      ...timedStage(start, end),
      attempt: start.attempt,
      modelId: start.modelId,
      outcome:
        end?.type === "model.retried" ? "failed" : (end?.outcome ?? null),
      provider: start.provider,
      queueDurationMs: durationMs(requested?.at, start.at),
      requestedAt: iso(requested?.at),
      retryAt: end?.type === "model.retried" ? iso(end.at) : null,
      runId: start.runId,
      turnToModelMs: durationMs(turnStarted?.at, start.at),
      usage,
      usageComplete: completeUsage(usage),
      usageRecordCount: recordCount,
    };
  });
  const modelAttempts = attributeModelAttempts(rawModelAttempts);
  const toolCalls = pairStages(
    scopedRows,
    "call.requested",
    "call.settled",
    (row) => row.callId
  ).map(({ end, start }) => ({
    ...timedStage(start, end),
    callId: start.callId,
  }));
  const interactions = pairStages(
    scopedRows,
    "interaction.opened",
    "interaction.settled",
    (row) => row.interactionId
  ).map(({ end, start }) => ({
    ...timedStage(start, end),
    interactionId: start.interactionId,
  }));

  for (const [stages, missingEnd] of [
    [modelAttempts, "model.settled"],
    [toolCalls, "call.settled"],
    [interactions, "interaction.settled"],
  ] as const) {
    if (stages.some((stage) => stage.endAt === null)) {
      missing.push(missingEnd);
    }
  }
  addMissingModelSettlement(missing, scopedRows, modelAttempts);

  const usageMetrics = usageCoverage(
    scopedRows,
    modelAttempts,
    scanTruncated || missing.length > 0
  );

  const eventCounts = Object.fromEntries(
    scopedRows.reduce((counts, row) => {
      counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
      return counts;
    }, new Map<string, number>())
  );
  const trace = turnStarted
    ? {
        spanId: metadataSpanId(turnStarted.spanId),
        traceId: metadataTraceId(turnStarted.traceId),
      }
    : { spanId: null, traceId: null };

  return {
    complete: missing.length === 0 && !scanTruncated,
    correlation: {
      callIds: compact(toolCalls.map((call) => call.callId)),
      deliveryId,
      interactionIds: compact(
        interactions.map((interaction) => interaction.interactionId)
      ),
      modelRunIds: compact(modelAttempts.map((attempt) => attempt.runId)),
      sessionId,
      spanId: trace.spanId,
      traceId: trace.traceId,
      turnId,
    },
    eventWindow: {
      eventCounts,
      firstLine: scopedRows[0]?.line ?? null,
      lastLine: scopedRows.at(-1)?.line ?? null,
      observedRows: scopedRows.length,
      scanTruncated,
    },
    message: {
      botSlug: message.botSlug,
      createdAt: iso(message.createdAt),
      deliveryId: message.deliveryId,
      id: message.id,
      status: message.status,
    },
    missing,
    stages: {
      delivery: {
        admittedAt: iso(admitted?.at),
        consumedAt: iso(consumed?.at),
        consumedDurationMs: durationMs(admitted?.at, consumed?.at),
        outcome: settled?.outcome ?? null,
        settledAt: iso(settled?.at),
        settledDurationMs: durationMs(admitted?.at, settled?.at),
      },
      interactions,
      modelAttempts,
      tools: toolCalls,
      turn: {
        durationMs: durationMs(turnStarted?.at, turnSettled?.at),
        endAt: iso(turnSettled?.at),
        outcome: turnSettled?.outcome ?? null,
        startAt: iso(turnStarted?.at),
        turnId,
      },
    },
    usage: {
      coverage: usageMetrics.coverage,
      modelRuns: usageMetrics.modelRuns,
      totals: usageMetrics.totals,
    },
  };
}
