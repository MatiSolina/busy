import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  type BotRow,
  botSessions,
  bots,
  consultations,
  db,
  events,
  messageDeliveryAttempts,
  messages,
  sessionRecoveries,
} from "../db";
import {
  createSession,
  endSession,
  type OutgoingMessage,
  sendMessage,
} from "../eve/client";
import { stopComputerObserved } from "../live";
import { type Stages, span } from "../trace";
import { consumptionIn } from "./consumption";
import {
  buildRecoveryPacket,
  MAX_RECOVERY_CONVERSATION,
  MAX_RECOVERY_EVENTS,
  RECOVERY_CONTEXT_KEY,
  RECOVERY_PACKET_VERSION,
  type RecoveryPacket,
  withoutUnprovenPlan,
} from "./recovery";
import { readRootPlanSnapshot } from "./recovery-plan-store";
import {
  claimHistory,
  ensureMainSession,
  markSessionEnded,
  registerMainSession,
  trackOrphanSession,
} from "./session";
import { botCall } from "./store";

// eve answers 409 session_not_active for an ended session and session_stranded for an unrecoverable one.
const SESSION_GONE =
  /eve send failed: (?<status>404|410)\b|"code"\s*:\s*"session_(?<state>not_active|stranded)"/u;
export const sessionGone = (message: string) => SESSION_GONE.test(message);

/** A send failed after Eve could have admitted it; never replay it elsewhere. */
export class UnknownDeliveryError extends Error {
  constructor(
    message = "The message delivery status is unknown; retrying the same session is required.",
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "UnknownDeliveryError";
  }
}

export function isUnknownDeliveryError(error: unknown): boolean {
  return error instanceof UnknownDeliveryError;
}

const RECOVERY_WAIT_ATTEMPTS = 5;
const RECOVERY_WAIT_MS = 25;
const TRANSPORT_ONLY_MESSAGES = new Set([
  "<encender_computadora/>",
  "<wake_computer/>",
]);

/**
 * Order of the seed history (H-35): a bot's main sessions by generation (`bot_sessions`), then the
 * stream position (line, index) inside one session; lines of different sessions are never
 * compared. A message sorts at the line of its delivery.admitted (not synced yet: after every
 * stored line of its session). Sessions from before the registry (no generation) come first and
 * only they fall back to timestamps, the hub's clock for messages and eve's for replies.
 */
interface HistoryKey {
  at: Date;
  generation: number | null;
  index: number;
  line: number | null;
}

const UNSYNCED_LINE = 2_147_483_647;

export function compareHistory(a: HistoryKey, b: HistoryKey): number {
  const ga = a.generation ?? -1;
  const gb = b.generation ?? -1;
  if (ga !== gb) {
    return ga - gb;
  }
  if (ga === -1) {
    return a.at.getTime() - b.at.getTime();
  }
  return (
    (a.line ?? UNSYNCED_LINE) - (b.line ?? UNSYNCED_LINE) || a.index - b.index
  );
}

/** The last exchanges as plain text, to seed a session that replaces a lost one (spec 4.1). */
export async function recentHistory(bot: BotRow): Promise<string> {
  // Correlated subqueries name the outer table explicitly: Drizzle leaves single-table columns
  // unqualified, which inside a subquery would bind to the inner table.
  const generationOf = (outer: "events" | "messages") =>
    sql<
      number | null
    >`(select bs.generation from ${botSessions} bs where bs.session_id = ${sql.raw(`${outer}.session_id`)})`;
  const messageGeneration = generationOf("messages");
  const admittedLine = sql<number | null>`(
    select e.line from ${events} e
    where e.session_id = messages.session_id
      and e.type = 'delivery.admitted'
      and e.data->'data'->>'deliveryId' = messages.delivery_id
    limit 1)`;
  const said = await db()
    .select({
      at: messages.createdAt,
      generation: messageGeneration,
      line: admittedLine,
      text: messages.text,
    })
    .from(messages)
    .where(and(eq(messages.botId, bot.id), eq(messages.status, "accepted")))
    .orderBy(
      desc(sql`coalesce(${messageGeneration}, -1)`),
      desc(
        sql`case when ${messageGeneration} is null then 0 else coalesce(${admittedLine}, ${UNSYNCED_LINE}) end`
      ),
      desc(messages.createdAt)
    )
    .limit(10);
  const replyGeneration = generationOf("events");
  const replies = await db()
    .select({
      at: events.at,
      data: events.data,
      generation: replyGeneration,
      index: events.index,
      line: events.line,
    })
    .from(events)
    .where(
      and(
        eq(events.botId, bot.id),
        eq(events.type, "content.completed"),
        // Only replies, filtered before the limit so a turn full of reasoning doesn't push them out.
        sql`${events.data}->'data'->>'kind' = 'text' and ${events.data}->'data'->>'phase' = 'reply'`,
        // A consultation's thread is stored under the asking bot, but those replies are the peer's words.
        notInArray(
          events.sessionId,
          db()
            .select({ id: consultations.childSessionId })
            .from(consultations)
            .where(isNotNull(consultations.childSessionId))
        )
      )
    )
    .orderBy(
      desc(sql`coalesce(${replyGeneration}, -1)`),
      desc(
        sql`case when ${replyGeneration} is null then 0 else ${events.line} end`
      ),
      desc(events.index),
      desc(events.at)
    )
    .limit(10);
  const lines = [
    ...said.map((m) => ({
      at: m.at,
      generation: m.generation,
      // Before the turn's own facts on its line.
      index: -1,
      line: m.line,
      text: `User: ${m.text}`,
    })),
    ...replies.map((r) => ({
      at: r.at,
      generation: r.generation,
      index: r.index,
      line: r.line,
      text: `You: ${String((r.data as { data: { value?: unknown } }).data.value)}`,
    })),
  ].sort(compareHistory);
  return lines
    .map((l) => l.text)
    .join("\n")
    .slice(-6000);
}

export interface RecoveryPlanResponse {
  botId: string;
  plan: Record<string, unknown>;
  predecessorSessionId: string | null;
  rootSessionId: string;
  version: 1;
}

/** Read a private full root plan for a server-authenticated current session. */
export async function recoveryPlanForSession(
  botId: string,
  sessionId: string
): Promise<RecoveryPlanResponse | null> {
  const [row] = await db()
    .select({
      botId: sessionRecoveries.botId,
      planSnapshot: sessionRecoveries.planSnapshot,
      reservedSessionId: sessionRecoveries.reservedSessionId,
      sourceSessionId: sessionRecoveries.sourceSessionId,
    })
    .from(sessionRecoveries)
    .where(
      and(
        eq(sessionRecoveries.botId, botId),
        eq(sessionRecoveries.reservedSessionId, sessionId),
        inArray(sessionRecoveries.state, ["active", "completed"])
      )
    )
    .orderBy(desc(sessionRecoveries.createdAt))
    .limit(1);
  if (!(row?.planSnapshot && row.reservedSessionId)) {
    return null;
  }
  return {
    botId: row.botId,
    plan: row.planSnapshot,
    predecessorSessionId: row.sourceSessionId,
    rootSessionId: row.reservedSessionId,
    version: 1,
  };
}

async function recoveryPacketFor(
  bot: BotRow,
  sourceSessionId: string | null
): Promise<{
  packet: RecoveryPacket;
  planSnapshot: Record<string, unknown> | null;
}> {
  const q = db();
  const consultationSessions = q
    .select({ id: consultations.childSessionId })
    .from(consultations)
    .where(isNotNull(consultations.childSessionId));
  const eventWhere = sourceSessionId
    ? and(
        eq(events.botId, bot.id),
        eq(events.sessionId, sourceSessionId),
        notInArray(events.sessionId, consultationSessions)
      )
    : and(
        eq(events.botId, bot.id),
        notInArray(events.sessionId, consultationSessions)
      );
  const eventRows = await q
    .select({
      at: events.at,
      data: events.data,
      index: events.index,
      line: events.line,
      sessionId: events.sessionId,
      type: events.type,
    })
    .from(events)
    .where(eventWhere)
    .orderBy(desc(events.line), desc(events.index))
    .limit(MAX_RECOVERY_EVENTS);
  const conversationRows = await q
    .select({ at: messages.createdAt, id: messages.id, text: messages.text })
    .from(messages)
    .where(and(eq(messages.botId, bot.id), eq(messages.status, "accepted")))
    .orderBy(desc(messages.createdAt))
    .limit(MAX_RECOVERY_CONVERSATION);
  const replyWhere = sourceSessionId
    ? and(
        eq(events.botId, bot.id),
        eq(events.sessionId, sourceSessionId),
        eq(events.type, "content.completed"),
        sql`${events.data}->'data'->>'kind' = 'text' and ${events.data}->'data'->>'phase' = 'reply'`
      )
    : and(
        eq(events.botId, bot.id),
        eq(events.type, "content.completed"),
        sql`${events.data}->'data'->>'kind' = 'text' and ${events.data}->'data'->>'phase' = 'reply'`,
        notInArray(events.sessionId, consultationSessions)
      );
  const replies = await q
    .select({
      at: events.at,
      data: events.data,
      index: events.index,
      line: events.line,
      sessionId: events.sessionId,
    })
    .from(events)
    .where(replyWhere)
    .orderBy(desc(events.at), desc(events.line), desc(events.index))
    .limit(MAX_RECOVERY_CONVERSATION);
  const conversation = [
    ...conversationRows.map((row) => ({
      at: row.at,
      id: String(row.id),
      role: "user" as const,
      sessionId: sourceSessionId,
      text: row.text,
    })),
    ...replies.map((row) => ({
      at: row.at,
      id: `${row.sessionId}:${row.line}:${row.index}`,
      role: "assistant" as const,
      sessionId: row.sessionId,
      text: replyValue(row.data),
    })),
  ];
  const orderedEvents = eventRows.toReversed();
  const planSnapshot = sourceSessionId
    ? await readRootPlanSnapshot(bot.id, sourceSessionId, orderedEvents)
    : null;
  const builtPacket = buildRecoveryPacket(
    orderedEvents,
    conversation,
    sourceSessionId,
    undefined,
    planSnapshot ?? undefined
  );
  // A bot without a current root has historical events, but no trustworthy
  // predecessor lineage. Do not silently restore an old root plan into a
  // brand-new session; the full history IDs remain available for lookup.
  const packet =
    sourceSessionId === null ? withoutUnprovenPlan(builtPacket) : builtPacket;
  return {
    packet,
    planSnapshot:
      sourceSessionId === null
        ? null
        : (planSnapshot as Record<string, unknown> | null),
  };
}

function recoveryContext(
  clientContext: Record<string, unknown> | undefined,
  packetId: string,
  packet: RecoveryPacket
): Record<string, unknown> {
  return {
    ...clientContext,
    [RECOVERY_CONTEXT_KEY]: {
      packet,
      packetId,
      sourceSessionId: packet.sourceSessionId,
      version: RECOVERY_PACKET_VERSION,
    },
  };
}

function replyValue(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const { data } = value as { data?: unknown };
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return "";
  }
  const text = (data as { value?: unknown }).value;
  return typeof text === "string" ? text : "";
}

interface DeliveryAttempt {
  botId: string;
  deliveryId: string | null;
  messageId: string;
  operationId: string;
  postingToken: string | null;
  postingUntil: Date | null;
  seededClientContext: Record<string, unknown> | null;
  seededText: string | null;
  sessionId: string | null;
  state: "reserved" | "sending" | "accepted" | "failed" | "unknown";
}

interface RecoveryReservation {
  adopted?: boolean;
  id: string;
  messageId: string;
  operationId: string;
  packet: RecoveryPacket;
  planSnapshot: Record<string, unknown> | null;
  reservedSessionId: string | null;
  seed: boolean;
  sourceSessionId: string | null;
  state: "prepared" | "creating" | "active" | "completed" | "failed";
  transitionWon?: boolean;
}

function messageOperationId(bot: BotRow, messageId: string): string {
  return `busy:message:${bot.id}:${messageId}`;
}

function recoveryOperationId(bot: BotRow, messageId: string): string {
  return `busy:recovery:${bot.id}:${messageId}`;
}

async function deliveryAttemptFor(
  bot: BotRow,
  messageId: string,
  messageText: string
): Promise<DeliveryAttempt> {
  const operationId = messageOperationId(bot, messageId);
  const q = db();
  if (!TRANSPORT_ONLY_MESSAGES.has(messageText)) {
    // The normal route owns a durable messages row. Wake transport is the
    // deliberate exception: it boots Live before a user message exists.
    const [owned] = await q
      .select({ botId: messages.botId })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.botId, bot.id)));
    if (!owned) {
      throw new Error("Message ownership could not be verified");
    }
  }
  await q
    .insert(messageDeliveryAttempts)
    .values({
      botId: bot.id,
      messageId,
      operationId,
      sessionId: bot.sessionId,
    })
    .onConflictDoNothing();
  const [row] = await q
    .select({
      botId: messageDeliveryAttempts.botId,
      deliveryId: messageDeliveryAttempts.deliveryId,
      messageId: messageDeliveryAttempts.messageId,
      operationId: messageDeliveryAttempts.operationId,
      postingToken: messageDeliveryAttempts.postingToken,
      postingUntil: messageDeliveryAttempts.postingUntil,
      seededClientContext: messageDeliveryAttempts.seededClientContext,
      seededText: messageDeliveryAttempts.seededText,
      sessionId: messageDeliveryAttempts.sessionId,
      state: messageDeliveryAttempts.state,
    })
    .from(messageDeliveryAttempts)
    .where(
      and(
        eq(messageDeliveryAttempts.botId, bot.id),
        eq(messageDeliveryAttempts.messageId, messageId)
      )
    );
  if (!row) {
    throw new Error("Could not persist the message delivery identity");
  }
  return row;
}

async function updateDeliveryAttempt(
  attempt: DeliveryAttempt,
  patch: Partial<
    Pick<
      DeliveryAttempt,
      | "deliveryId"
      | "postingToken"
      | "postingUntil"
      | "seededClientContext"
      | "seededText"
      | "sessionId"
      | "state"
    >
  >,
  envelopeOnly = false
): Promise<DeliveryAttempt> {
  const next = { ...attempt, ...patch };
  const previousSession = attempt.sessionId;
  const previousSessionPredicate = previousSession
    ? eq(messageDeliveryAttempts.sessionId, previousSession)
    : isNull(messageDeliveryAttempts.sessionId);
  const previousTokenPredicate = attempt.postingToken
    ? eq(messageDeliveryAttempts.postingToken, attempt.postingToken)
    : isNull(messageDeliveryAttempts.postingToken);
  const [row] = await db()
    .update(messageDeliveryAttempts)
    .set({
      ...(patch.deliveryId === undefined
        ? {}
        : { deliveryId: patch.deliveryId }),
      ...(patch.sessionId === undefined ? {} : { sessionId: patch.sessionId }),
      ...(patch.postingToken === undefined
        ? {}
        : { postingToken: patch.postingToken }),
      ...(patch.postingUntil === undefined
        ? {}
        : { postingUntil: patch.postingUntil }),
      ...(patch.seededClientContext === undefined
        ? {}
        : { seededClientContext: patch.seededClientContext }),
      ...(patch.seededText === undefined
        ? {}
        : { seededText: patch.seededText }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(messageDeliveryAttempts.botId, attempt.botId),
        eq(messageDeliveryAttempts.messageId, attempt.messageId),
        eq(messageDeliveryAttempts.operationId, attempt.operationId),
        eq(messageDeliveryAttempts.state, attempt.state),
        previousSessionPredicate,
        previousTokenPredicate,
        ...(envelopeOnly ? [isNull(messageDeliveryAttempts.seededText)] : [])
      )
    )
    .returning({
      botId: messageDeliveryAttempts.botId,
      deliveryId: messageDeliveryAttempts.deliveryId,
      messageId: messageDeliveryAttempts.messageId,
      operationId: messageDeliveryAttempts.operationId,
      postingToken: messageDeliveryAttempts.postingToken,
      postingUntil: messageDeliveryAttempts.postingUntil,
      seededClientContext: messageDeliveryAttempts.seededClientContext,
      seededText: messageDeliveryAttempts.seededText,
      sessionId: messageDeliveryAttempts.sessionId,
      state: messageDeliveryAttempts.state,
    });
  if (row) {
    return row;
  }
  const [current] = await db()
    .select({
      botId: messageDeliveryAttempts.botId,
      deliveryId: messageDeliveryAttempts.deliveryId,
      messageId: messageDeliveryAttempts.messageId,
      operationId: messageDeliveryAttempts.operationId,
      postingToken: messageDeliveryAttempts.postingToken,
      postingUntil: messageDeliveryAttempts.postingUntil,
      seededClientContext: messageDeliveryAttempts.seededClientContext,
      seededText: messageDeliveryAttempts.seededText,
      sessionId: messageDeliveryAttempts.sessionId,
      state: messageDeliveryAttempts.state,
    })
    .from(messageDeliveryAttempts)
    .where(
      and(
        eq(messageDeliveryAttempts.botId, attempt.botId),
        eq(messageDeliveryAttempts.messageId, attempt.messageId)
      )
    );
  if (
    current?.state === "accepted" ||
    current?.state === "sending" ||
    current?.state === "unknown"
  ) {
    return current;
  }
  return current ?? next;
}

const POSTING_LEASE_MS = 30_000;

async function claimAttempt(
  attempt: DeliveryAttempt
): Promise<{ attempt: DeliveryAttempt; claimed: boolean }> {
  const token = randomUUID();
  const until = new Date(Date.now() + POSTING_LEASE_MS);
  const previousSessionPredicate = attempt.sessionId
    ? eq(messageDeliveryAttempts.sessionId, attempt.sessionId)
    : isNull(messageDeliveryAttempts.sessionId);
  const previousTokenPredicate = attempt.postingToken
    ? eq(messageDeliveryAttempts.postingToken, attempt.postingToken)
    : isNull(messageDeliveryAttempts.postingToken);
  const [row] = await db()
    .update(messageDeliveryAttempts)
    .set({ postingToken: token, postingUntil: until, state: "sending" })
    .where(
      and(
        eq(messageDeliveryAttempts.botId, attempt.botId),
        eq(messageDeliveryAttempts.messageId, attempt.messageId),
        eq(messageDeliveryAttempts.operationId, attempt.operationId),
        eq(messageDeliveryAttempts.state, attempt.state),
        previousSessionPredicate,
        previousTokenPredicate,
        or(
          isNull(messageDeliveryAttempts.postingUntil),
          lt(messageDeliveryAttempts.postingUntil, new Date())
        )
      )
    )
    .returning({
      botId: messageDeliveryAttempts.botId,
      deliveryId: messageDeliveryAttempts.deliveryId,
      messageId: messageDeliveryAttempts.messageId,
      operationId: messageDeliveryAttempts.operationId,
      postingToken: messageDeliveryAttempts.postingToken,
      postingUntil: messageDeliveryAttempts.postingUntil,
      seededClientContext: messageDeliveryAttempts.seededClientContext,
      seededText: messageDeliveryAttempts.seededText,
      sessionId: messageDeliveryAttempts.sessionId,
      state: messageDeliveryAttempts.state,
    });
  if (row) {
    return { attempt: row, claimed: true };
  }
  const [current] = await db()
    .select({
      botId: messageDeliveryAttempts.botId,
      deliveryId: messageDeliveryAttempts.deliveryId,
      messageId: messageDeliveryAttempts.messageId,
      operationId: messageDeliveryAttempts.operationId,
      postingToken: messageDeliveryAttempts.postingToken,
      postingUntil: messageDeliveryAttempts.postingUntil,
      seededClientContext: messageDeliveryAttempts.seededClientContext,
      seededText: messageDeliveryAttempts.seededText,
      sessionId: messageDeliveryAttempts.sessionId,
      state: messageDeliveryAttempts.state,
    })
    .from(messageDeliveryAttempts)
    .where(
      and(
        eq(messageDeliveryAttempts.botId, attempt.botId),
        eq(messageDeliveryAttempts.messageId, attempt.messageId)
      )
    );
  return { attempt: current ?? attempt, claimed: false };
}

async function recordAcceptedAttempt(
  attempt: DeliveryAttempt,
  deliveryId: string
): Promise<DeliveryAttempt> {
  try {
    return await updateDeliveryAttempt(attempt, {
      deliveryId,
      state: "accepted",
    });
  } catch (error) {
    // Eve has accepted the idempotency key. A database outage must not turn
    // that authoritative result into a retry on a different session.
    throw new UnknownDeliveryError(undefined, { cause: error });
  }
}

async function sendPinned(
  call: ReturnType<typeof botCall>,
  sessionId: string,
  msg: OutgoingMessage,
  stages?: Stages
): Promise<
  | { deliveryId: string; kind: "accepted" }
  | { kind: "gone" }
  | { kind: "unknown" }
> {
  try {
    const sent = await span(
      "eve.send",
      () => sendMessage(call, sessionId, msg),
      stages
    );
    return { ...sent, kind: "accepted" };
  } catch (error) {
    // A retry with the exact same idempotency key is Eve's delivery-status
    // reconciliation. It is safe after admission and never changes sessions.
    if (error instanceof Error && sessionGone(error.message)) {
      return { kind: "gone" };
    }
    try {
      const sent = await span(
        "eve.send.reconcile",
        () => sendMessage(call, sessionId, msg),
        stages
      );
      return { ...sent, kind: "accepted" };
    } catch {
      return { kind: "unknown" };
    }
  }
}

type SendResult = Awaited<ReturnType<typeof sendPinned>>;

function envelopeMessage(
  base: OutgoingMessage,
  attempt: DeliveryAttempt
): OutgoingMessage | null {
  if (attempt.seededText === null || attempt.seededText === undefined) {
    return null;
  }
  return {
    ...base,
    text: attempt.seededText,
    ...(attempt.seededClientContext === null
      ? { clientContext: undefined }
      : { clientContext: attempt.seededClientContext }),
  };
}

async function sendExistingSession(
  bot: BotRow,
  msg: OutgoingMessage,
  call: ReturnType<typeof botCall>,
  attempt: DeliveryAttempt,
  stages?: Stages
): Promise<{
  attempt: DeliveryAttempt;
  claimed: boolean;
  result: SendResult;
  sessionId: string;
  stateBeforePost: DeliveryAttempt["state"];
}> {
  let current = attempt;
  const { sessionId } = current;
  if (!sessionId) {
    throw new UnknownDeliveryError();
  }
  let pinnedMsg: OutgoingMessage;
  if (current.seededText === null || current.seededText === undefined) {
    // Exactly one first message seeds a session that owes its history (H-23): the duty is claimed
    // with a compare-and-set on this very session, never on whatever the bot points to now.
    const seed = bot.historyPending && (await claimHistory(bot.id, sessionId));
    pinnedMsg = seed ? await seeded(bot, msg, stages) : msg;
  } else {
    pinnedMsg = {
      ...msg,
      text: current.seededText,
      ...(current.seededClientContext === null
        ? { clientContext: undefined }
        : { clientContext: current.seededClientContext }),
    };
  }
  if (current.seededText === null || current.seededText === undefined) {
    current = await updateDeliveryAttempt(
      current,
      {
        seededClientContext: pinnedMsg.clientContext ?? null,
        seededText: pinnedMsg.text,
      },
      true
    );
  }
  const stateBeforePost = current.state;
  const claimed = await claimAttempt(current);
  current = claimed.attempt;
  if (!claimed.claimed) {
    if (current.state === "accepted" && current.deliveryId) {
      return {
        attempt: current,
        claimed: false,
        result: { deliveryId: current.deliveryId, kind: "accepted" },
        sessionId,
        stateBeforePost,
      };
    }
    return {
      attempt: current,
      claimed: false,
      result: { kind: "unknown" },
      sessionId,
      stateBeforePost,
    };
  }
  const persisted = envelopeMessage(msg, current);
  if (!persisted || current.sessionId !== sessionId) {
    return {
      attempt: current,
      claimed: false,
      result: { kind: "unknown" },
      sessionId,
      stateBeforePost,
    };
  }
  const result = await sendPinned(call, sessionId, persisted, stages);
  return {
    attempt: current,
    claimed: true,
    result,
    sessionId,
    stateBeforePost,
  };
}

async function reconcileExistingUnknown(attempt: DeliveryAttempt): Promise<{
  attempt: DeliveryAttempt;
  deliveryId?: string;
  outcome: "accepted" | "unknown";
}> {
  const current = await updateDeliveryAttempt(attempt, {
    postingUntil: null,
    state: "unknown",
  });
  return current.state === "accepted" && current.deliveryId
    ? {
        attempt: current,
        deliveryId: current.deliveryId,
        outcome: "accepted",
      }
    : { attempt: current, outcome: "unknown" };
}

/**
 * Whether a gone session consumed the message, from its stored stream (H-36). Retirement after a
 * lost acknowledgement is not evidence by itself; a readable stream without the turn is. Anything
 * that cannot be read stays "unknown", which keeps the attempt pinned.
 */
async function consumedInGoneSession(
  bot: BotRow,
  sessionId: string,
  msg: OutgoingMessage
): Promise<{ deliveryId: string } | null | "unknown"> {
  try {
    return await consumptionIn(bot, sessionId, {
      fileCount: msg.files.length,
      text: msg.text,
    });
  } catch {
    return "unknown";
  }
}

async function reconcileExistingGone(
  bot: BotRow,
  msg: OutgoingMessage,
  attempt: DeliveryAttempt,
  stateBeforePost: DeliveryAttempt["state"],
  sessionId: string
): Promise<{
  attempt: DeliveryAttempt;
  deliveryId?: string;
  outcome: "accepted" | "gone" | "unknown";
}> {
  if (stateBeforePost !== "reserved" && stateBeforePost !== "failed") {
    // A send that may have been admitted moves only after the dead session's stream shows the
    // message never ran there; a consumption settles it in that session instead.
    const evidence = await consumedInGoneSession(bot, sessionId, msg);
    if (evidence === "unknown") {
      // Release the lease as `unknown`: the sweeper and a retry reconcile it in this session.
      return reconcileExistingUnknown(attempt);
    }
    if (evidence) {
      const accepted = await recordAcceptedAttempt(
        attempt,
        evidence.deliveryId
      );
      return accepted.state === "accepted" && accepted.deliveryId
        ? {
            attempt: accepted,
            deliveryId: accepted.deliveryId,
            outcome: "accepted",
          }
        : { attempt: accepted, outcome: "unknown" };
    }
  }
  const failed = await updateDeliveryAttempt(attempt, {
    postingUntil: null,
    state: "failed",
  });
  if (
    failed.state !== "failed" ||
    failed.postingToken !== attempt.postingToken
  ) {
    return failed.state === "accepted" && failed.deliveryId
      ? {
          attempt: failed,
          deliveryId: failed.deliveryId,
          outcome: "accepted",
        }
      : { attempt: failed, outcome: "unknown" };
  }
  await stopLostSessionComputer(bot, sessionId).catch((error) =>
    console.warn("send: could not stop the lost session's computer", {
      error,
    })
  );
  return { attempt: failed, outcome: "gone" };
}

async function handleExistingSession(
  bot: BotRow,
  msg: OutgoingMessage,
  call: ReturnType<typeof botCall>,
  attempt: DeliveryAttempt,
  stages?: Stages
): Promise<{
  attempt: DeliveryAttempt;
  deliveryId?: string;
  outcome: "accepted" | "gone" | "unknown";
}> {
  const existing = await sendExistingSession(bot, msg, call, attempt, stages);
  let current = existing.attempt;
  if (!existing.claimed && existing.result.kind !== "accepted") {
    return { attempt: current, outcome: "unknown" };
  }
  if (existing.result.kind === "accepted") {
    if (existing.claimed) {
      current = await recordAcceptedAttempt(
        current,
        existing.result.deliveryId
      );
    }
    if (bot.historyPending) {
      const acceptedSession = current.sessionId;
      if (!acceptedSession) {
        throw new UnknownDeliveryError();
      }
      await db()
        .update(bots)
        .set({ historyPending: false })
        .where(and(eq(bots.id, bot.id), eq(bots.sessionId, acceptedSession)));
    }
    return {
      attempt: current,
      deliveryId: existing.result.deliveryId,
      outcome: "accepted",
    };
  }
  if (existing.result.kind === "unknown") {
    return reconcileExistingUnknown(current);
  }
  return reconcileExistingGone(
    bot,
    msg,
    current,
    existing.stateBeforePost,
    existing.sessionId
  );
}

async function sendReplacementMessage(
  bot: BotRow,
  msg: OutgoingMessage,
  call: ReturnType<typeof botCall>,
  attempt: DeliveryAttempt,
  reservation: RecoveryReservation,
  stages?: Stages
): Promise<{
  attempt: DeliveryAttempt;
  claimed: boolean;
  message: OutgoingMessage;
  result: SendResult;
}> {
  let current = attempt;
  if (current.state === "accepted" && current.deliveryId) {
    return {
      attempt: current,
      claimed: false,
      message: msg,
      result: { deliveryId: current.deliveryId, kind: "accepted" },
    };
  }
  const sessionId = reservation.reservedSessionId;
  if (!sessionId) {
    throw new UnknownDeliveryError();
  }
  current = await updateDeliveryAttempt(current, {
    postingToken: null,
    postingUntil: null,
    seededClientContext: null,
    seededText: null,
    sessionId,
    state: "reserved",
  });
  if (current.state === "accepted" && current.deliveryId) {
    return {
      attempt: current,
      claimed: false,
      message: msg,
      result: { deliveryId: current.deliveryId, kind: "accepted" },
    };
  }
  const message = reservation.seed
    ? await seeded(bot, msg, stages, reservation)
    : msg;
  current = await updateDeliveryAttempt(
    current,
    {
      seededClientContext: message.clientContext ?? null,
      seededText: message.text,
    },
    true
  );
  if (current.state === "accepted" && current.deliveryId) {
    return {
      attempt: current,
      claimed: false,
      message,
      result: { deliveryId: current.deliveryId, kind: "accepted" },
    };
  }
  const claimed = await claimAttempt(current);
  current = claimed.attempt;
  if (!claimed.claimed) {
    return {
      attempt: current,
      claimed: false,
      message,
      result: { kind: "unknown" },
    };
  }
  const persisted = envelopeMessage(msg, current);
  if (!persisted || current.sessionId !== sessionId) {
    return {
      attempt: current,
      claimed: false,
      message,
      result: { kind: "unknown" },
    };
  }
  const result = await sendPinned(call, sessionId, persisted, stages);
  return { attempt: current, claimed: true, message: persisted, result };
}

async function recoveryRowForBot(
  botId: string
): Promise<RecoveryReservation | null> {
  const [row] = await db()
    .select({
      id: sessionRecoveries.id,
      messageId: sessionRecoveries.messageId,
      operationId: sessionRecoveries.operationId,
      packet: sessionRecoveries.packet,
      planSnapshot: sessionRecoveries.planSnapshot,
      reservedSessionId: sessionRecoveries.reservedSessionId,
      sourceSessionId: sessionRecoveries.sourceSessionId,
      state: sessionRecoveries.state,
    })
    .from(sessionRecoveries)
    .where(
      and(
        eq(sessionRecoveries.botId, botId),
        inArray(sessionRecoveries.state, [
          "prepared",
          "creating",
          "active",
          "completed",
        ])
      )
    )
    .orderBy(desc(sessionRecoveries.createdAt))
    .limit(1);
  if (!row) {
    return null;
  }
  const candidate: RecoveryReservation = {
    ...row,
    packet: row.packet as RecoveryPacket,
    seed: false,
  };
  if (!candidate.reservedSessionId) {
    return candidate;
  }
  const [pointer] = await db()
    .select({ sessionId: bots.sessionId })
    .from(bots)
    .where(eq(bots.id, botId));
  if (pointer?.sessionId === candidate.reservedSessionId) {
    return candidate;
  }
  if (candidate.state === "active") {
    await saveRecoveryState(candidate, { state: "failed" }).catch(
      () => undefined
    );
    return null;
  }
  if (candidate.state === "completed") {
    return null;
  }
  return candidate;
}

async function saveRecoveryState(
  reservation: RecoveryReservation,
  patch: Partial<
    Pick<RecoveryReservation, "reservedSessionId" | "state" | "seed">
  >
): Promise<RecoveryReservation> {
  const previousReservedPredicate = reservation.reservedSessionId
    ? eq(sessionRecoveries.reservedSessionId, reservation.reservedSessionId)
    : isNull(sessionRecoveries.reservedSessionId);
  const [row] = await db()
    .update(sessionRecoveries)
    .set({
      ...(patch.reservedSessionId === undefined
        ? {}
        : { reservedSessionId: patch.reservedSessionId }),
      ...(patch.state === undefined ? {} : { state: patch.state }),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionRecoveries.id, reservation.id),
        eq(sessionRecoveries.state, reservation.state),
        previousReservedPredicate
      )
    )
    .returning({
      id: sessionRecoveries.id,
      messageId: sessionRecoveries.messageId,
      operationId: sessionRecoveries.operationId,
      packet: sessionRecoveries.packet,
      planSnapshot: sessionRecoveries.planSnapshot,
      reservedSessionId: sessionRecoveries.reservedSessionId,
      sourceSessionId: sessionRecoveries.sourceSessionId,
      state: sessionRecoveries.state,
    });
  if (row) {
    return {
      ...row,
      packet: row.packet as RecoveryPacket,
      seed: patch.seed ?? reservation.seed,
      transitionWon: true,
    };
  }
  const [actual] = await db()
    .select({
      id: sessionRecoveries.id,
      messageId: sessionRecoveries.messageId,
      operationId: sessionRecoveries.operationId,
      packet: sessionRecoveries.packet,
      planSnapshot: sessionRecoveries.planSnapshot,
      reservedSessionId: sessionRecoveries.reservedSessionId,
      sourceSessionId: sessionRecoveries.sourceSessionId,
      state: sessionRecoveries.state,
    })
    .from(sessionRecoveries)
    .where(eq(sessionRecoveries.id, reservation.id));
  if (actual) {
    return {
      ...actual,
      packet: actual.packet as RecoveryPacket,
      seed:
        actual.messageId === reservation.messageId &&
        actual.state !== "completed",
      transitionWon: false,
    };
  }
  throw new UnknownDeliveryError();
}

async function endUnusedRecoveryTarget(
  bot: BotRow,
  reservation: RecoveryReservation,
  targetSessionId: string,
  call: ReturnType<typeof botCall>
): Promise<void> {
  if (reservation.transitionWon !== true) {
    return;
  }
  const [pointer] = await db()
    .select({ sessionId: bots.sessionId })
    .from(bots)
    .where(eq(bots.id, bot.id));
  if (pointer?.sessionId === targetSessionId) {
    return;
  }
  const [attempt] = await db()
    .select({ id: messageDeliveryAttempts.id })
    .from(messageDeliveryAttempts)
    .where(
      and(
        eq(messageDeliveryAttempts.botId, bot.id),
        eq(messageDeliveryAttempts.sessionId, targetSessionId),
        inArray(messageDeliveryAttempts.state, [
          "sending",
          "accepted",
          "unknown",
        ])
      )
    )
    .limit(1);
  if (!attempt) {
    // Recorded first, so a crash or an eve outage here leaves it to endOrphanSessions (H-02).
    await trackOrphanSession(
      bot.id,
      targetSessionId,
      reservation.operationId
    ).catch((error) =>
      console.warn("send: could not record the unused recovery target", {
        error,
      })
    );
    const ended = await endSession(call, targetSessionId).catch(() => false);
    if (ended) {
      await markSessionEnded(targetSessionId).catch(() => undefined);
    }
  }
}

async function resolveActiveRecovery(
  botId: string,
  row: {
    id: string;
    messageId: string;
    operationId: string;
    packet: unknown;
    planSnapshot: Record<string, unknown> | null;
    reservedSessionId: string | null;
    sourceSessionId: string | null;
    state: RecoveryReservation["state"];
  }
): Promise<
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "use"; reservation: RecoveryReservation }
> {
  if (!(row.state === "active" && row.reservedSessionId)) {
    return { kind: "none" };
  }
  const [pointer] = await db()
    .select({ sessionId: bots.sessionId })
    .from(bots)
    .where(eq(bots.id, botId));
  if (pointer?.sessionId === row.reservedSessionId) {
    return {
      kind: "use",
      reservation: {
        ...row,
        packet: row.packet as RecoveryPacket,
        seed: false,
      },
    };
  }
  await saveRecoveryState(
    { ...row, packet: row.packet as RecoveryPacket, seed: false },
    { state: "failed" }
  ).catch(() => undefined);
  if (pointer?.sessionId) {
    return {
      kind: "use",
      reservation: {
        ...row,
        adopted: true,
        packet: row.packet as RecoveryPacket,
        reservedSessionId: pointer.sessionId,
        seed: false,
        sourceSessionId: pointer.sessionId,
        state: "active",
      },
    };
  }
  return { kind: "new" };
}

async function reserveRecovery(
  bot: BotRow,
  messageId: string,
  sourceSessionId: string | null,
  operationIdOverride?: string
): Promise<RecoveryReservation> {
  const operationId =
    operationIdOverride ?? recoveryOperationId(bot, messageId);
  let existingActive = await recoveryRowForBot(bot.id);
  if (
    existingActive &&
    (existingActive.state === "active" ||
      existingActive.state === "completed") &&
    existingActive.reservedSessionId === sourceSessionId
  ) {
    // The source just returned an explicit session-gone response; never reuse
    // an active recovery that still points at that same retired target.
    if (existingActive.state === "active") {
      await saveRecoveryState(existingActive, { state: "failed" }).catch(
        () => undefined
      );
    }
    existingActive = null;
  }
  if (existingActive && existingActive.messageId !== messageId) {
    return existingActive;
  }
  const recovery = await span(
    "message.recovery.packet",
    () => recoveryPacketFor(bot, sourceSessionId),
    undefined
  );
  const { packet, planSnapshot } = recovery;
  const q = db();
  const id = randomUUID();
  await q
    .insert(sessionRecoveries)
    .values({
      botId: bot.id,
      id,
      messageId,
      operationId,
      packet,
      planSnapshot,
      sourceSessionId,
    })
    .onConflictDoNothing();
  const [row] = await q
    .select({
      id: sessionRecoveries.id,
      messageId: sessionRecoveries.messageId,
      operationId: sessionRecoveries.operationId,
      packet: sessionRecoveries.packet,
      planSnapshot: sessionRecoveries.planSnapshot,
      reservedSessionId: sessionRecoveries.reservedSessionId,
      sourceSessionId: sessionRecoveries.sourceSessionId,
      state: sessionRecoveries.state,
    })
    .from(sessionRecoveries)
    .where(eq(sessionRecoveries.operationId, operationId));
  if (row?.state === "completed" && row.reservedSessionId === sourceSessionId) {
    return reserveRecovery(
      bot,
      messageId,
      sourceSessionId,
      `${operationId}:${randomUUID()}`
    );
  }
  if (row?.state === "active" && row.reservedSessionId) {
    const resolved = await resolveActiveRecovery(bot.id, row);
    if (resolved.kind === "use") {
      return resolved.reservation;
    }
    if (resolved.kind === "new") {
      return reserveRecovery(
        bot,
        messageId,
        sourceSessionId,
        `${operationId}:${randomUUID()}`
      );
    }
  }
  if (row?.state === "failed") {
    return reserveRecovery(
      bot,
      messageId,
      sourceSessionId,
      `${operationId}:${randomUUID()}`
    );
  }
  if (row) {
    return {
      ...row,
      packet: row.packet as RecoveryPacket,
      seed: row.messageId === messageId && row.state !== "completed",
    };
  }
  const concurrent = await recoveryRowForBot(bot.id);
  if (concurrent) {
    return concurrent;
  }
  throw new Error("Could not reserve a session recovery");
}

async function reconcileCreationClaim(
  bot: BotRow,
  current: RecoveryReservation,
  sessionId: string,
  call: ReturnType<typeof botCall>
): Promise<RecoveryReservation | null> {
  if (current.state === "completed") {
    const [pointer] = await db()
      .select({ sessionId: bots.sessionId })
      .from(bots)
      .where(eq(bots.id, bot.id));
    if (pointer?.sessionId === sessionId) {
      return current;
    }
    throw new UnknownDeliveryError();
  }
  if (current.state === "failed") {
    await endUnusedRecoveryTarget(bot, current, sessionId, call);
    throw new UnknownDeliveryError();
  }
  if (
    !(
      (current.state === "creating" || current.state === "active") &&
      current.reservedSessionId === sessionId
    )
  ) {
    throw new UnknownDeliveryError();
  }
  return null;
}

async function activateRecovery(
  bot: BotRow,
  reservation: RecoveryReservation,
  call: ReturnType<typeof botCall>
): Promise<RecoveryReservation> {
  let current = reservation;
  let sessionId = current.reservedSessionId;
  if (!sessionId) {
    // The create response may be lost after Eve creates the session. Keep the
    // prepared row and operationId for reconciliation on the next request.
    sessionId = await createSession(call, current.operationId);
    current = await saveRecoveryState(current, {
      reservedSessionId: sessionId,
      state: "creating",
    });
    const terminal = await reconcileCreationClaim(
      bot,
      current,
      sessionId,
      call
    );
    if (terminal) {
      return terminal;
    }
  }

  const sourcePredicate = current.sourceSessionId
    ? eq(bots.sessionId, current.sourceSessionId)
    : isNull(bots.sessionId);
  const [updated] = await db()
    .update(bots)
    .set({ historyPending: false, sessionId })
    .where(and(eq(bots.id, bot.id), sourcePredicate))
    .returning({ sessionId: bots.sessionId });
  if (updated) {
    // The next main-session generation, so history orders it after its predecessor (H-35).
    await registerMainSession(bot.id, sessionId, current.operationId).catch(
      (error) =>
        console.warn("send: could not register the replacement session", {
          error,
        })
    );
  } else {
    const [latest] = await db()
      .select({ sessionId: bots.sessionId })
      .from(bots)
      .where(eq(bots.id, bot.id));
    if (latest?.sessionId !== sessionId) {
      current = await saveRecoveryState(current, { state: "failed" });
      await endUnusedRecoveryTarget(bot, current, sessionId, call);
      if (latest?.sessionId && latest.sessionId !== current.sourceSessionId) {
        // Live may have won the no-session CAS while this request was
        // preparing its packet. Reuse that canonical session and let this
        // message provide the first seeded turn. The same holds when another
        // writer (Live, a deploy, a routine) already replaced the dead source:
        // its session is the bot's, never open a third (H-02, H-23).
        return {
          ...current,
          reservedSessionId: latest.sessionId,
          seed: true,
          state: "active",
        };
      }
      throw new UnknownDeliveryError();
    }
  }
  return saveRecoveryState(current, { state: "active" });
}

async function waitForRecovery(
  bot: BotRow,
  call: ReturnType<typeof botCall>
): Promise<RecoveryReservation | null> {
  for (let attempt = 0; attempt < RECOVERY_WAIT_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each poll observes the prior reservation state.
    const row = await recoveryRowForBot(bot.id);
    if (!row) {
      return row;
    }
    if (row.state === "failed") {
      return null;
    }
    if (
      row.reservedSessionId &&
      (row.state === "active" || row.state === "completed")
    ) {
      const [pointer] = await db()
        .select({ sessionId: bots.sessionId })
        .from(bots)
        .where(eq(bots.id, bot.id));
      if (pointer?.sessionId === row.reservedSessionId) {
        return row;
      }
      if (row.state === "active") {
        await saveRecoveryState(row, { state: "failed" }).catch(
          () => undefined
        );
        return null;
      }
    }
    // A reservation in `prepared`/`creating` belongs to another request. Do
    // not create a second session while its stable operation is unresolved.
    await (
      call.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    )(RECOVERY_WAIT_MS * (attempt + 1));
  }
  return (await recoveryRowForBot(bot.id)) ?? null;
}

async function completeRecovery(
  reservation: RecoveryReservation
): Promise<void> {
  if (reservation.state === "completed") {
    return;
  }
  await saveRecoveryState(reservation, { state: "completed" });
}

async function replacementSession(
  bot: BotRow,
  messageId: string,
  sourceSessionId: string | null,
  call: ReturnType<typeof botCall>
): Promise<RecoveryReservation> {
  let reservation = await reserveRecovery(bot, messageId, sourceSessionId);
  if (reservation.messageId !== messageId && !reservation.adopted) {
    const waited = await waitForRecovery(bot, call);
    if (!waited) {
      throw new UnknownDeliveryError();
    }
    reservation = waited;
  }
  if (reservation.state === "failed") {
    throw new UnknownDeliveryError();
  }
  if (reservation.state !== "active" && reservation.state !== "completed") {
    reservation = await activateRecovery(bot, reservation, call);
  }
  if (!reservation.reservedSessionId) {
    throw new UnknownDeliveryError();
  }
  return {
    ...reservation,
    seed:
      reservation.messageId === messageId && reservation.state !== "completed",
  };
}

async function stopLostSessionComputer(
  bot: BotRow,
  sourceSessionId: string | null
): Promise<void> {
  if (!sourceSessionId) {
    return;
  }
  const [claimed] = await db()
    .update(bots)
    .set({ liveUntil: null })
    .where(and(eq(bots.id, bot.id), eq(bots.sessionId, sourceSessionId)))
    .returning({ sessionId: bots.sessionId });
  if (claimed?.sessionId !== sourceSessionId) {
    return;
  }
  await stopComputerObserved(
    { ...bot, sessionId: sourceSessionId },
    "internal",
    randomUUID()
  );
}

/**
 * Sends to the bot's single chat session. Replaces the session once if eve lost or ended it, and
 * opens one when the bot has none (a rotated bot: its next computer comes from the current image).
 */
export async function sendToBot(
  bot: BotRow,
  outgoing: OutgoingMessage,
  stages?: Stages
): Promise<{ deliveryId: string }> {
  const discussions = await span(
    "message.fireside",
    async () => {
      const { firesideContext } = await import("../firesides/store");
      return firesideContext(bot.id);
    },
    stages
  );
  const msg = discussions.length
    ? {
        ...outgoing,
        clientContext: {
          ...outgoing.clientContext,
          firesideNote:
            "Attributed second opinions, not established consensus. Use read_fireside for the full discussion.",
          firesides: discussions,
        },
      }
    : outgoing;
  const call = botCall(bot.slug);
  let attempt = await deliveryAttemptFor(bot, msg.id, msg.text);
  if (attempt.state === "accepted" && attempt.deliveryId) {
    return { deliveryId: attempt.deliveryId };
  }

  // The attempt row pins every retry to the exact session that may have
  // accepted the message, even if another request has since rotated the bot.
  if (attempt.sessionId) {
    const existing = await handleExistingSession(
      bot,
      msg,
      call,
      attempt,
      stages
    );
    ({ attempt } = existing);
    if (existing.outcome === "accepted" && existing.deliveryId) {
      return { deliveryId: existing.deliveryId };
    }
    if (existing.outcome === "unknown") {
      throw new UnknownDeliveryError();
    }
  }

  const reservation = await replacementSession(
    bot,
    msg.id,
    attempt.sessionId,
    call
  );
  const replacementSessionId = reservation.reservedSessionId;
  if (!replacementSessionId) {
    throw new UnknownDeliveryError();
  }
  const replacement = await sendReplacementMessage(
    bot,
    msg,
    call,
    attempt,
    reservation,
    stages
  );
  ({ attempt } = replacement);
  const { result } = replacement;
  if (result.kind === "unknown") {
    if (replacement.claimed) {
      await updateDeliveryAttempt(attempt, {
        postingUntil: null,
        state: "unknown",
      });
    }
    throw new UnknownDeliveryError();
  }
  if (result.kind === "gone") {
    // The replacement was never admitted. Keep its operation identity and
    // leave the message pending; a later retry can reconcile the same target.
    await updateDeliveryAttempt(attempt, {
      postingUntil: null,
      state: "unknown",
    });
    throw new UnknownDeliveryError();
  }
  if (!replacement.claimed) {
    return { deliveryId: result.deliveryId };
  }
  attempt = await recordAcceptedAttempt(attempt, result.deliveryId);
  if (reservation.seed) {
    await completeRecovery(reservation);
  }
  return { deliveryId: attempt.deliveryId ?? result.deliveryId };
}

// A function, not a constant: evaluated per query, never when the module loads.
const attemptColumns = () => ({
  botId: messageDeliveryAttempts.botId,
  deliveryId: messageDeliveryAttempts.deliveryId,
  messageId: messageDeliveryAttempts.messageId,
  operationId: messageDeliveryAttempts.operationId,
  postingToken: messageDeliveryAttempts.postingToken,
  postingUntil: messageDeliveryAttempts.postingUntil,
  seededClientContext: messageDeliveryAttempts.seededClientContext,
  seededText: messageDeliveryAttempts.seededText,
  sessionId: messageDeliveryAttempts.sessionId,
  state: messageDeliveryAttempts.state,
});

/**
 * The message sweeper's re-send (H-21, lib/chat/attempts.ts): the persisted envelope, to the pinned
 * session, with the same idempotency key. It never opens or moves to another session; `gone` leaves
 * the attempt `unknown` for the caller to settle with the dead session's evidence.
 */
export async function resendPinned(
  bot: BotRow,
  messageId: string
): Promise<
  { deliveryId: string; kind: "accepted" } | { kind: "gone" | "unknown" }
> {
  const [row] = await db()
    .select(attemptColumns())
    .from(messageDeliveryAttempts)
    .where(
      and(
        eq(messageDeliveryAttempts.botId, bot.id),
        eq(messageDeliveryAttempts.messageId, messageId)
      )
    );
  if (row?.state === "accepted" && row.deliveryId) {
    return { deliveryId: row.deliveryId, kind: "accepted" };
  }
  const sessionId = row?.sessionId;
  if (!(row && sessionId) || row.seededText === null) {
    return { kind: "unknown" };
  }
  const claimed = await claimAttempt(row);
  if (!claimed.claimed) {
    return claimed.attempt.state === "accepted" && claimed.attempt.deliveryId
      ? { deliveryId: claimed.attempt.deliveryId, kind: "accepted" }
      : { kind: "unknown" };
  }
  const envelope = envelopeMessage(
    { files: [], id: messageId, text: "" },
    claimed.attempt
  );
  const result = envelope
    ? await sendPinned(botCall(bot.slug), sessionId, envelope)
    : ({ kind: "unknown" } as const);
  if (result.kind === "accepted") {
    await recordAcceptedAttempt(claimed.attempt, result.deliveryId);
    return result;
  }
  await updateDeliveryAttempt(claimed.attempt, {
    postingUntil: null,
    state: "unknown",
  });
  return result;
}

/** Ends a pinned attempt whose session is gone and whose stream shows it never ran (H-21). */
export async function failGoneAttempt(
  botId: string,
  messageId: string
): Promise<boolean> {
  const rows = await db()
    .update(messageDeliveryAttempts)
    .set({ postingUntil: null, state: "failed", updatedAt: new Date() })
    .where(
      and(
        eq(messageDeliveryAttempts.botId, botId),
        eq(messageDeliveryAttempts.messageId, messageId),
        eq(messageDeliveryAttempts.state, "unknown")
      )
    )
    .returning({ id: messageDeliveryAttempts.id });
  return rows.length > 0;
}

async function seeded(
  bot: BotRow,
  msg: OutgoingMessage,
  stages?: Stages,
  reservation?: RecoveryReservation
): Promise<OutgoingMessage> {
  const history = await span(
    "message.history",
    () => recentHistory(bot),
    stages
  );
  const text = history
    ? `<prior_history>\n${history}\n</prior_history>\n\n${msg.text}`
    : msg.text;
  return {
    ...msg,
    text,
    ...(reservation
      ? {
          clientContext: recoveryContext(
            msg.clientContext,
            reservation.id,
            reservation.packet
          ),
        }
      : {}),
  };
}

/**
 * A session opened before any message (the live screen needs one to have a computer). Its first
 * message, through sendToBot, carries the recent history.
 */
export async function openSession(bot: BotRow): Promise<BotRow> {
  // Two opens at once (two taps, two tabs, or Live and a first message) must get one session: a
  // second one's computer would race the first for the bot's Drive, which takes one writer. One
  // opener holds the reservation; the install is a compare-and-set and any loser adopts the winner.
  const main = await ensureMainSession(bot, { call: botCall(bot.slug) });
  return main.bot;
}

const SESSION_RESET_REPLAY_LINES = 120;

export function persistedEvents(sessionId: string, afterLine: number) {
  return db()
    .select({
      data: events.data,
      index: events.index,
      line: events.line,
      type: events.type,
    })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gt(events.line, afterLine)))
    .orderBy(asc(events.line), asc(events.index));
}

/** Main-chat reset replay: bounded by complete lines, never by individual facts. */
export async function persistedTailEvents(sessionId: string) {
  const lines = await db()
    .selectDistinct({ line: events.line })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(desc(events.line))
    .limit(SESSION_RESET_REPLAY_LINES);
  const oldest = lines.at(-1);
  if (!oldest) {
    return [];
  }
  return db()
    .select({
      data: events.data,
      index: events.index,
      line: events.line,
      type: events.type,
    })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), gte(events.line, oldest.line)))
    .orderBy(asc(events.line), asc(events.index));
}
