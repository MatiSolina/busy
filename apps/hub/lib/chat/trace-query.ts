import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { db, events, messages } from "../db";
import { buildChatTraceTimeline, type ChatTraceEvent } from "./observability";

export const traceSelect = {
  at: sql<Date>`${events.at}`.as("at"),
  attemptText: sql<string | null>`${events.data}->'data'->>'attempt'`.as(
    "attempt_text"
  ),
  callId: sql<string | null>`${events.data}->'data'->>'callId'`.as("call_id"),
  deliveryId: sql<string | null>`${events.data}->'data'->>'deliveryId'`.as(
    "delivery_id"
  ),
  errorCode: sql<string | null>`${events.data}->'data'->'error'->>'code'`.as(
    "error_code"
  ),
  index: sql<number>`${events.index}`.as("index"),
  interactionId: sql<
    string | null
  >`${events.data}->'data'->>'interactionId'`.as("interaction_id"),
  line: sql<number>`${events.line}`.as("line"),
  modelId: sql<string | null>`${events.data}->'data'->>'modelId'`.as(
    "model_id"
  ),
  outcome: sql<string | null>`${events.data}->'data'->>'outcome'`.as("outcome"),
  provider: sql<string | null>`coalesce(
    ${events.data}->'data'->>'provider',
    ${events.data}->'data'->>'providerId'
  )`.as("provider"),
  runId: sql<string | null>`coalesce(
    ${events.data}->'scope'->>'runId',
    ${events.data}->'data'->>'runId'
  )`.as("run_id"),
  sessionId: sql<string>`${events.sessionId}`.as("session_id"),
  spanId: sql<string | null>`${events.data}->'data'->'trace'->>'spanId'`.as(
    "span_id"
  ),
  traceId: sql<string | null>`${events.data}->'data'->'trace'->>'traceId'`.as(
    "trace_id"
  ),
  turnId: sql<
    string | null
  >`coalesce(${events.data}->'scope'->>'turnId', ${events.data}->'data'->>'turnId')`.as(
    "turn_id"
  ),
  type: sql<string>`${events.type}`.as("type"),
  usageCacheReadText: sql<
    string | null
  >`${events.data}->'data'->'usage'->>'cacheReadTokens'`.as(
    "usage_cache_read_text"
  ),
  usageCacheWriteText: sql<
    string | null
  >`${events.data}->'data'->'usage'->>'cacheWriteTokens'`.as(
    "usage_cache_write_text"
  ),
  usageCostText: sql<
    string | null
  >`${events.data}->'data'->'usage'->>'costUsd'`.as("usage_cost_text"),
  usageInputText: sql<
    string | null
  >`${events.data}->'data'->'usage'->>'inputTokens'`.as("usage_input_text"),
  usageKind: sql<string | null>`${events.data}->'data'->>'kind'`.as(
    "usage_kind"
  ),
  usageOutputText: sql<
    string | null
  >`${events.data}->'data'->'usage'->>'outputTokens'`.as("usage_output_text"),
  usageOwnerCallId: sql<
    string | null
  >`${events.data}->'data'->'owner'->>'callId'`.as("usage_owner_call_id"),
  usageOwnerRunId: sql<
    string | null
  >`${events.data}->'data'->'owner'->>'runId'`.as("usage_owner_run_id"),
};

export interface TraceSelectRow {
  at: Date;
  attemptText: string | null;
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
  sessionId: string;
  spanId: string | null;
  traceId: string | null;
  turnId: string | null;
  type: string;
  usageCacheReadText: string | null;
  usageCacheWriteText: string | null;
  usageCostText: string | null;
  usageInputText: string | null;
  usageKind: string | null;
  usageOutputText: string | null;
  usageOwnerCallId: string | null;
  usageOwnerRunId: string | null;
}

export function asTraceEvent(row: TraceSelectRow): ChatTraceEvent {
  const parsedAttempt = row.attemptText ? Number(row.attemptText) : null;
  return {
    at: row.at,
    attempt: Number.isInteger(parsedAttempt) ? parsedAttempt : null,
    callId: row.callId,
    deliveryId: row.deliveryId,
    errorCode: row.errorCode,
    index: row.index,
    interactionId: row.interactionId,
    line: row.line,
    modelId: row.modelId,
    outcome: row.outcome,
    provider: row.provider,
    runId: row.runId,
    spanId: row.spanId,
    traceId: row.traceId,
    turnId: row.turnId,
    type: row.type,
    usageCacheReadText: row.usageCacheReadText,
    usageCacheWriteText: row.usageCacheWriteText,
    usageCostText: row.usageCostText,
    usageInputText: row.usageInputText,
    usageKind: row.usageKind,
    usageOutputText: row.usageOutputText,
    usageOwnerCallId: row.usageOwnerCallId,
    usageOwnerRunId: row.usageOwnerRunId,
  };
}

const MAX_SCAN_ROWS = 1000;
const DELIVERY_TYPES = [
  "delivery.admitted",
  "delivery.consumed",
  "delivery.settled",
] as const;

export type ChatTraceTimeline = ReturnType<typeof buildChatTraceTimeline>;

/**
 * Reads one message's persisted turn, metadata columns only. Null when the message is not this
 * bot's. Shared by the trace endpoint and the latency probe cron.
 */
export async function loadChatTrace(
  bot: { id: string; slug: string },
  messageId: string
): Promise<ChatTraceTimeline | null> {
  const [messageRow] = await db()
    .select({
      createdAt: messages.createdAt,
      deliveryId: messages.deliveryId,
      id: messages.id,
      status: messages.status,
    })
    .from(messages)
    .where(and(eq(messages.id, messageId), eq(messages.botId, bot.id)))
    .limit(1);
  const message = messageRow ? { ...messageRow, botSlug: bot.slug } : null;
  if (!message) {
    return null;
  }

  const empty = buildChatTraceTimeline(message, null, []);
  if (!message.deliveryId) {
    return empty;
  }

  const deliveryRows = await db()
    .select(traceSelect)
    .from(events)
    .where(
      and(
        eq(events.botId, bot.id),
        inArray(events.type, [...DELIVERY_TYPES]),
        sql`${events.data}->'data'->>'deliveryId' = ${message.deliveryId}`
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(32);
  const [firstDelivery] = deliveryRows;
  if (!firstDelivery) {
    return empty;
  }

  const { sessionId } = firstDelivery;
  const targetTurnId = deliveryRows.find((row) => row.turnId)?.turnId ?? null;
  const targetEvents = targetTurnId
    ? or(
        sql`${events.data}->'scope'->>'turnId' = ${targetTurnId}`,
        sql`${events.data}->'data'->>'turnId' = ${targetTurnId}`,
        sql`${events.data}->'data'->>'deliveryId' = ${message.deliveryId}`
      )
    : sql`${events.data}->'data'->>'deliveryId' = ${message.deliveryId}`;
  const scannedRows = await db()
    .select(traceSelect)
    .from(events)
    .where(
      and(
        eq(events.botId, bot.id),
        eq(events.sessionId, sessionId),
        targetEvents
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(MAX_SCAN_ROWS + 1);
  const scanTruncated = scannedRows.length > MAX_SCAN_ROWS;
  const rows = scannedRows.slice(0, MAX_SCAN_ROWS).map(asTraceEvent);
  const timeline = buildChatTraceTimeline(
    message,
    sessionId,
    rows,
    scanTruncated
  );
  return timeline;
}
