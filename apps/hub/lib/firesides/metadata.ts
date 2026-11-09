import type { ClientRow, Fact } from "../chat/items";
import type { StreamRecord } from "../eve/client";
import type {
  ActiveTurn,
  FiresideRuntime,
  FiresideRuntimeEvent,
  Participant,
} from "./types";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/iu;
const SPAN_ID = /^[0-9a-f]{16}$/iu;
export const MAX_FIRESIDE_RUNTIME_EVENTS = 5000;
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
  "session.ended",
  "turn.paused",
  "turn.settled",
  "turn.started",
  "usage.recorded",
]);
const OUTCOMES = new Set([
  "accepted",
  "awaiting-input",
  "cancelled",
  "completed",
  "failed",
  "handled",
  "rejected",
  "running",
  "settled",
]);

export function firesideTerminalOutcome(
  outcome: unknown
): "completed" | "failed" | "skipped" {
  if (outcome === "completed") {
    return "completed";
  }
  if (outcome === "cancelled" || outcome === "rejected") {
    return "skipped";
  }
  return "failed";
}

export function shouldProjectFiresideTurn(
  current: { messageId: string; revision: number } | null,
  target: { messageId: string; revision: number }
): boolean {
  return Boolean(
    current &&
      current.messageId === target.messageId &&
      current.revision === target.revision
  );
}

function id(value: unknown): string | null {
  return typeof value === "string" && SAFE_ID.test(value) ? value : null;
}

function traceId(value: unknown): string | null {
  return typeof value === "string" && TRACE_ID.test(value) ? value : null;
}

function spanId(value: unknown): string | null {
  return typeof value === "string" && SPAN_ID.test(value) ? value : null;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return new Date(value).toISOString();
}

/** Projects one persisted fact to IDs/timestamps only; no prompt, delta or result fields survive. */
export function firesideRuntimeEvent(
  line: number,
  record: StreamRecord["record"],
  fact: Fact
): FiresideRuntimeEvent | null {
  if (!EVENT_TYPES.has(fact.type)) {
    return null;
  }
  const { data } = fact;
  const scope = fact.scope ?? {};
  const { trace } = data;
  const traceObject =
    trace && typeof trace === "object" && !Array.isArray(trace)
      ? (trace as Record<string, unknown>)
      : {};
  const outcome =
    typeof data.outcome === "string" && OUTCOMES.has(data.outcome)
      ? data.outcome
      : null;
  return {
    at: timestamp(record.at),
    callId: id(data.callId),
    interactionId: id(data.interactionId),
    line,
    outcome,
    runId: id(scope.runId) ?? id(data.runId),
    spanId: spanId(traceObject.spanId),
    traceId: traceId(traceObject.traceId),
    turnId: id(scope.turnId) ?? id(data.turnId),
    type: fact.type,
  };
}

export function runtimeMetadata(
  active: ActiveTurn,
  participant: Participant
): FiresideRuntime {
  const events = active.eventMetadata ?? [];
  return {
    calls: active.rows.filter(
      (row: ClientRow) =>
        row.type === "call.requested" || row.type === "call.settled"
    ),
    deliveryId: id(active.deliveryId),
    events: events.slice(-MAX_FIRESIDE_RUNTIME_EVENTS),
    eventsTruncated:
      active.eventsTruncated === true ||
      events.length > MAX_FIRESIDE_RUNTIME_EVENTS,
    model: participant.model,
    provider: participant.billing,
    sessionId: participant.sessionId ?? "",
    turnId: id(active.turnId),
  };
}
