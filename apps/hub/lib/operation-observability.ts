import { errorCodeOf } from "./chat/observability";

type OperationFlow =
  | "code_task"
  | "consultation"
  | "fireside"
  | "library"
  | "live"
  | "routine";
export type OperationEntryPoint = "cron" | "http" | "internal" | "workflow";
type OperationStage =
  | "dispatch"
  | "model"
  | "promotion"
  | "session"
  | "terminal"
  | "tool";
type OperationOutcome =
  | "accepted"
  | "completed"
  | "failed"
  | "pending"
  | "rejected"
  | "started"
  | "skipped"
  | "timeout";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const SAFE_LABEL = /^[A-Za-z0-9._:/@-]{1,200}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/iu;
const SPAN_ID = /^[0-9a-f]{16}$/iu;
const SQLSTATE = /^[0-9A-Z]{5}$/u;
const SAFE_ERROR_CODES = new Set([
  "AbortError",
  "ClientError",
  "DrizzleQueryError",
  "Error",
  "FetchError",
  "PostgresError",
  "TimeoutError",
  "TypeError",
  "unknown",
]);
const SAFE_KEYS = new Set([
  "botId",
  "callId",
  "childSessionId",
  "deploymentId",
  "durationMs",
  "entryPoint",
  "errorCode",
  "flow",
  "httpStatus",
  "model",
  "operationId",
  "outcome",
  "parentSessionId",
  "provider",
  "requestId",
  "sessionId",
  "spanId",
  "stage",
  "traceId",
  "turnId",
]);
const FLOWS = new Set<OperationFlow>([
  "code_task",
  "consultation",
  "fireside",
  "library",
  "live",
  "routine",
]);
const STAGES = new Set<OperationStage>([
  "dispatch",
  "model",
  "promotion",
  "session",
  "terminal",
  "tool",
]);
const OUTCOMES = new Set<OperationOutcome>([
  "accepted",
  "completed",
  "failed",
  "pending",
  "rejected",
  "started",
  "skipped",
  "timeout",
]);
const ENTRY_POINTS = new Set<OperationEntryPoint>([
  "cron",
  "http",
  "internal",
  "workflow",
]);

export interface OperationObservation {
  botId?: string | null;
  callId?: string | null;
  childSessionId?: string | null;
  deploymentId?: string | null;
  durationMs?: number | null;
  entryPoint: OperationEntryPoint;
  errorCode?: string | null;
  flow: OperationFlow;
  httpStatus?: number | null;
  model?: string | null;
  operationId: string;
  outcome: OperationOutcome;
  parentSessionId?: string | null;
  provider?: string | null;
  requestId?: string | null;
  sessionId?: string | null;
  spanId?: string | null;
  stage: OperationStage;
  traceId?: string | null;
  turnId?: string | null;
}

function numericValue(key: string, value: number): number | undefined {
  if (key === "durationMs") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
  }
  if (key === "httpStatus") {
    return Number.isInteger(value) && value >= 100 && value <= 599
      ? value
      : undefined;
  }
  return undefined;
}

function stringValue(key: string, value: string): string | undefined {
  if (key === "errorCode") {
    return SQLSTATE.test(value) || SAFE_ERROR_CODES.has(value)
      ? value
      : undefined;
  }
  if (key === "traceId") {
    return TRACE_ID.test(value) ? value : undefined;
  }
  if (key === "spanId") {
    return SPAN_ID.test(value) ? value : undefined;
  }
  const regex = key === "model" || key === "provider" ? SAFE_LABEL : SAFE_ID;
  return regex.test(value) ? value : undefined;
}

function safeValue(
  key: string,
  value: unknown
): string | number | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "number") {
    return numericValue(key, value);
  }
  return typeof value === "string" ? stringValue(key, value) : undefined;
}

/**
 * Metadata-only lifecycle observations for non-chat critical flows. Unknown fields are dropped
 * before serialization, and logging failures never affect the operation being measured.
 */
export function observeOperation(fields: OperationObservation): void {
  if (
    !(
      FLOWS.has(fields.flow) &&
      STAGES.has(fields.stage) &&
      OUTCOMES.has(fields.outcome) &&
      ENTRY_POINTS.has(fields.entryPoint) &&
      typeof fields.operationId === "string" &&
      SAFE_ID.test(fields.operationId)
    )
  ) {
    return;
  }
  try {
    const record: Record<string, string | number | null> = {
      entryPoint: fields.entryPoint,
      flow: fields.flow,
      outcome: fields.outcome,
      source: "busy.operation",
      stage: fields.stage,
    };
    for (const [key, value] of Object.entries(fields)) {
      if (
        !SAFE_KEYS.has(key) ||
        key === "flow" ||
        key === "entryPoint" ||
        key === "outcome" ||
        key === "stage" ||
        value === undefined
      ) {
        continue;
      }
      const safe = safeValue(key, value);
      if (safe !== undefined) {
        record[key] = safe;
      }
    }
    console.info(JSON.stringify(record));
  } catch {
    // Observability must never change lease, delivery, or cleanup behavior.
  }
}

export const operationErrorCode = (error: unknown): string =>
  error instanceof Error ? errorCodeOf(error) : "unknown";
