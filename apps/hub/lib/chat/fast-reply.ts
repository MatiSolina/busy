import { createOpenAI } from "@ai-sdk/openai";
import { getVercelOidcToken } from "@vercel/oidc";
import { createGateway, type LanguageModel, streamText, tool } from "ai";
import {
  and,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  like,
  lt,
  ne,
  notLike,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import {
  hasSubscriptionModel,
  nativeSubscriptionModel,
  prepareSubscriptionBody,
  subscriptionHeaders,
  subscriptionUrl,
} from "../ai/inference";
import { getSubscriptionAccess } from "../ai/subscription-store";
import { coveredByTokenPass, isSubscriptionBilling } from "../bots/models";
import {
  type BotRow,
  bots,
  codeTasks,
  consultations,
  db,
  events,
  firesides,
  memories,
  messages,
} from "../db";
import { type Stages, span } from "../trace";
import {
  FAST_DELIVERY_PREFIX,
  FAST_INDEX_BASE,
  type FastExchange,
  type FastRow,
  type FastSlot,
  fastAckEnabled,
  fastAckRows,
  fastClosingRows,
  fastDeliveryId,
  fastOpeningRows,
  fastPartId,
  fastSystemPrompt,
  fastTurnId,
} from "./fast-path";
import {
  consumeFastSlot,
  FastSlotLost,
  releaseFastSlot,
  reserveFastSlot,
} from "./fast-slots";
import { sessionBusy, sessionTurn } from "./open-turn";
import { parseReaction, REACTIONS } from "./reactions";
import { recentHistory } from "./send";

const ACTIVE_CODE_TASK = [
  "queued",
  "running",
  "waiting_for_input",
  "cancel_requested",
] as const;
const PENDING_MESSAGE_WINDOW_MS = 10 * 60_000;

// A consultation is one bounded bot-to-bot call. A row still "open" after this long leaked (its call
// ended without settling it) and must not keep the bot off the fast path forever.
const CONSULTATION_WINDOW_MS = 15 * 60_000;
// Firesides that are still talking; closed ones only leave a summary behind.
const ACTIVE_FIRESIDE = ["running", "waiting", "paused", "closing"] as const;

/**
 * ChatGPT's subscription model reasons before its first token even for "hi" (3-4 s measured). A
 * simple turn doesn't need it: `FAST_PATH_REASONING_EFFORT` (default `low`, `none` to leave the
 * model's default) sets the effort. A model that rejects it fails the call, and the turn falls back
 * to the bot.
 */
export function fastReasoningEffort(
  billing: string,
  value = process.env.FAST_PATH_REASONING_EFFORT
): string | undefined {
  if (billing !== "chatgpt") {
    return;
  }
  const effort = value ?? "low";
  return effort === "none" || !effort ? undefined : effort;
}

export type FastIneligible =
  | "busy"
  | "code_task"
  | "consultation"
  | "fireside"
  | "model"
  | "no_session";

/**
 * The bot's own state must be idle: no running or paused turn, no message eve hasn't taken yet,
 * no consultation, fireside or code task. Any of those means the bot's context is moving.
 */
export async function fastIneligible(
  bot: BotRow,
  messageId: string
): Promise<FastIneligible | null> {
  if (!bot.sessionId || bot.historyPending) {
    return "no_session";
  }
  if (
    bot.billing === "token-pass" &&
    !(coveredByTokenPass(bot.model) && process.env.TOKEN_PASS_API_KEY)
  ) {
    return "model";
  }
  const { sessionId } = bot;
  const q = db();
  const [turn, lastNormal, waiting, consulting, coding, talking] =
    await Promise.all([
      // Running, waiting for the user, or not verified as gone: all keep the turn's context moving.
      sessionTurn(sessionId),
      q
        .select({ deliveryId: messages.deliveryId })
        .from(messages)
        .where(
          and(
            eq(messages.botId, bot.id),
            eq(messages.status, "accepted"),
            notLike(messages.deliveryId, `${FAST_DELIVERY_PREFIX}%`)
          )
        )
        .orderBy(desc(messages.createdAt))
        .limit(1),
      q
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.botId, bot.id),
            eq(messages.status, "pending"),
            ne(messages.id, messageId),
            gt(
              messages.createdAt,
              new Date(Date.now() - PENDING_MESSAGE_WINDOW_MS)
            )
          )
        )
        .limit(1),
      q
        .select({ id: consultations.id })
        .from(consultations)
        .where(
          and(
            eq(consultations.status, "open"),
            gt(
              consultations.createdAt,
              new Date(Date.now() - CONSULTATION_WINDOW_MS)
            ),
            or(
              eq(consultations.fromBotId, bot.id),
              eq(consultations.toBotId, bot.id)
            )
          )
        )
        .limit(1),
      q
        .select({ id: codeTasks.id })
        .from(codeTasks)
        .where(
          and(
            eq(codeTasks.botId, bot.id),
            inArray(codeTasks.status, [...ACTIVE_CODE_TASK])
          )
        )
        .limit(1),
      q
        .select({ id: firesides.id })
        .from(firesides)
        .where(
          and(
            eq(firesides.botId, bot.id),
            inArray(firesides.status, [...ACTIVE_FIRESIDE])
          )
        )
        .limit(1),
    ]);
  if (consulting.length) {
    return "consultation";
  }
  if (coding.length) {
    return "code_task";
  }
  if (talking.length) {
    return "fireside";
  }
  if (turn.state === "ended") {
    return "no_session";
  }
  if (waiting.length || sessionBusy(turn)) {
    return "busy";
  }
  const lastDelivery = lastNormal[0]?.deliveryId;
  if (lastDelivery) {
    // eve accepted it, but has its turn taken it yet?
    const [taken] = await q
      .select({ line: events.line })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          eq(events.type, "delivery.consumed"),
          // An ack stores the user's message under eve's delivery id too; only eve's own row means taken.
          lt(events.index, FAST_INDEX_BASE),
          sql`${events.data}->'data'->>'deliveryId' = ${lastDelivery}`
        )
      )
      .limit(1);
    if (!taken) {
      return "busy";
    }
  }
  return null;
}

async function memoryOf(slug: string): Promise<string | null> {
  const [row] = await db()
    .select({ content: memories.content })
    .from(memories)
    .where(eq(memories.botSlug, slug));
  return row?.content ?? null;
}

/** The bot's model, paid the same way its turns are (spec 4.9): never a different account. */
export async function fastModel(bot: BotRow): Promise<LanguageModel> {
  if (isSubscriptionBilling(bot.billing)) {
    const provider = bot.billing;
    const native = nativeSubscriptionModel(provider, bot.model);
    if (!native) {
      throw new Error("model_unavailable");
    }
    const access = await getSubscriptionAccess(provider);
    if (!hasSubscriptionModel(access.models, provider, bot.model)) {
      throw new Error("subscription_model_unavailable");
    }
    // Same upstream, body filter and headers as /api/bot/ai/responses; only the caller differs.
    const openai = createOpenAI({
      apiKey: "busy-hub",
      fetch: (_input, init) =>
        fetch(subscriptionUrl(provider), {
          body: JSON.stringify(
            prepareSubscriptionBody(
              provider,
              JSON.parse(String(init?.body ?? "{}")),
              native
            )
          ),
          headers: subscriptionHeaders(provider, access.credentials),
          method: "POST",
          redirect: "error",
          signal: init?.signal,
        }),
      name: `busy-${provider}`,
    });
    return openai.responses(native);
  }
  const apiKey =
    bot.billing === "token-pass"
      ? process.env.TOKEN_PASS_API_KEY
      : (process.env.AI_GATEWAY_API_KEY ?? (await getVercelOidcToken()));
  if (!apiKey) {
    throw new Error("provider_unconfigured");
  }
  return createGateway({ apiKey })(bot.model);
}

export type FastLine =
  | { fact: FastRow }
  | {
      progress: {
        data: { delta: string; kind: "text"; partId: string };
        type: "content.delta";
      };
    }
  | { retract: true };

export interface FastResult {
  /** Escalated after a short line the user already saw (`FAST_PATH_ACK`): keep it, see `persistAck`. */
  ack?: { reply: string; slot: FastSlot };
  escalated: boolean;
  inputTokens?: number;
  outputTokens?: number;
  reply: string;
  /** Short "-ing" phrase from `escalate` ("Finding leads for Acme"): the status line while the bot works. */
  status?: string;
  ttftMs?: number;
}

/**
 * The fast model must start (text or `escalate`) within this, or the message goes to the bot. A hung
 * provider otherwise holds the message: grok.com once answered a 520 after 40 s (2026-11-09), and
 * the route's maxDuration is 60 s. Observed first output: 0.5–5 s.
 */
export const FAST_FIRST_OUTPUT_MS = 8000;
const MAX_STATUS_CHARS = 60;
const SPACES = /\s+/gu;
const TRAILING_DOTS = /[.…\s]+$/u;

function silenceError(): Error {
  const error = new Error("fast model silent");
  error.name = "TimeoutError";
  return error;
}

/**
 * Model, memory and history, plus the slot reserved before the model runs (H-34): concurrent
 * exchanges get distinct indexes. A failure releases the slot it already reserved.
 */
async function fastContext(
  bot: BotRow,
  model: LanguageModel | undefined,
  messageId: string,
  stages?: Stages
): Promise<[LanguageModel, string | null, string, FastSlot]> {
  const sessionId = bot.sessionId as string;
  const reserving = reserveFastSlot(sessionId, messageId);
  try {
    return await span(
      "fast.context",
      () =>
        Promise.all([
          model ?? fastModel(bot),
          memoryOf(bot.slug),
          recentHistory(bot),
          reserving,
        ]),
      stages
    );
  } catch (error) {
    const reserved = await reserving.catch(() => null);
    if (reserved) {
      await releaseFastSlot(sessionId, reserved, messageId);
    }
    throw error;
  }
}

/** The caller falls back to the bot with the same message id; log why. */
function warnSlotLost(error: unknown, messageId: string, sessionId: string) {
  if (error instanceof FastSlotLost) {
    console.warn("[fast] slot reservation lost", { messageId, sessionId });
  }
}

/**
 * Streams one reply with a single `escalate` tool. The user's message and a running turn are shown at
 * the first token; an escalation (or failure) after that retracts them. On success the four rows
 * and the message's acceptance are stored together, so a reload shows the same exchange.
 */
export async function runFastReply(
  {
    ack = fastAckEnabled(),
    bot,
    messageId,
    model,
    mustEscalate,
    text,
  }: {
    ack?: boolean;
    bot: BotRow;
    mustEscalate?: "files" | "url";
    messageId: string;
    model?: LanguageModel;
    text: string;
  },
  emit: (line: FastLine) => void,
  stages?: Stages
): Promise<FastResult> {
  const startedAt = performance.now();
  const sessionId = bot.sessionId as string;
  const [resolved, memory, history, slot] = await fastContext(
    bot,
    model,
    messageId,
    stages
  );
  const abort = new AbortController();
  let silent = false;
  const silence = setTimeout(() => {
    silent = true;
    abort.abort();
  }, FAST_FIRST_OUTPUT_MS);
  let kept = false;
  let reply = "";
  let opened = false;
  let escalated = false;
  let reaction: string | undefined;
  let status: string | undefined;
  let ttftMs: number | undefined;
  const effort = fastReasoningEffort(bot.billing);
  const result = streamText({
    abortSignal: abort.signal,
    ...(effort
      ? { providerOptions: { openai: { reasoningEffort: effort } } }
      : {}),
    // A failure falls back to the normal path at once; retrying would only add latency.
    maxRetries: 0,
    messages: [{ content: text, role: "user" }],
    model: resolved,
    system: fastSystemPrompt(bot, memory, history, ack, mustEscalate),
    tools: {
      escalate: tool({
        description: ack
          ? "Hand this message to your full self, with your computer and tools. Write one short line first saying what you'll do."
          : "Hand this message to your full self, with your computer and tools. Call it before writing anything.",
        inputSchema: z.object({
          status: z
            .string()
            .optional()
            .describe(
              "What you're about to do, 2-6 words starting with an -ing verb, in the user's language, no trailing punctuation. E.g. \"Finding leads for Acme\"."
            ),
        }),
      }),
      react: tool({
        description:
          "React to the user's message with one emoji instead of replying, for a thanks, an ok or a done.",
        inputSchema: z.object({ emoji: z.enum(REACTIONS) }),
      }),
    },
  });
  const open = () => {
    if (opened) {
      return;
    }
    opened = true;
    ttftMs = Math.round(performance.now() - startedAt);
    for (const r of fastOpeningRows(slot, messageId, text)) {
      emit({ fact: r });
    }
  };
  const onDelta = (delta: string) => {
    open();
    reply += delta;
    emit({
      progress: {
        data: { delta, kind: "text", partId: fastPartId(messageId) },
        type: "content.delta",
      },
    });
  };
  try {
    await span(
      "fast.model",
      async () => {
        for await (const part of result.fullStream) {
          if (part.type === "tool-call" && part.toolName === "escalate") {
            escalated = true;
            status = statusOf(part.input);
            abort.abort();
            break;
          }
          if (part.type === "tool-call" && part.toolName === "react") {
            clearTimeout(silence);
            reaction = parseReaction(part.input) ?? reaction;
            open();
            continue;
          }
          if (part.type === "error") {
            throw part.error;
          }
          if (part.type === "text-delta" && part.text) {
            clearTimeout(silence);
            onDelta(part.text);
          }
        }
      },
      stages
    );
    clearTimeout(silence);
    if (silent) {
      throw silenceError();
    }
    // Files and links always reach the bot, even if the model answered instead of escalating.
    if (mustEscalate) {
      escalated = true;
    }
    if (escalated && ack && reply.trim()) {
      // Shown and kept: the caller delivers to eve, then stores it under eve's delivery id. The
      // reservation stays until `persistAck` consumes it, or expires if eve never took the message.
      kept = true;
      return {
        ack: { reply, slot },
        escalated: true,
        reply: "",
        status,
        ttftMs,
      };
    }
    if (escalated || !(reply.trim() || reaction)) {
      if (opened) {
        emit({ retract: true });
      }
      return { escalated: true, reply: "", status, ttftMs };
    }
    await persist(bot, slot, messageId, text, reply, reaction, stages);
    kept = true;
  } catch (error) {
    clearTimeout(silence);
    if (opened) {
      emit({ retract: true });
    }
    warnSlotLost(error, messageId, sessionId);
    // An abort for silence surfaces as whatever the provider threw; log it as what it was.
    throw silent ? silenceError() : error;
  } finally {
    if (!kept) {
      // Escalated or failed: nothing is stored at this slot.
      await releaseFastSlot(sessionId, slot, messageId);
    }
  }
  for (const r of fastClosingRows(slot, messageId, reply, reaction)) {
    emit({ fact: r });
  }
  const usage = await Promise.resolve(result.totalUsage).catch(() => undefined);
  return {
    escalated: false,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    reply,
    ttftMs,
  };
}

function persist(
  bot: BotRow,
  slot: FastSlot,
  messageId: string,
  text: string,
  reply: string,
  reaction: string | undefined,
  stages?: Stages
) {
  const rows = [
    ...fastOpeningRows(slot, messageId, text),
    ...fastClosingRows(slot, messageId, reply, reaction),
  ];
  return span(
    "fast.persist",
    () =>
      db().transaction(async (tx) => {
        const at = new Date();
        await consumeFastSlot(tx, bot.sessionId as string, slot, messageId);
        await tx.insert(events).values(
          rows.map((r) => ({
            at,
            botId: bot.id,
            data: r.data,
            index: r.index,
            line: r.line,
            sessionId: bot.sessionId as string,
            type: r.type,
          }))
        );
        await tx
          .update(messages)
          .set({ deliveryId: fastDeliveryId(messageId), status: "accepted" })
          .where(eq(messages.id, messageId));
      }),
    stages
  );
}

/**
 * Stores an ack once eve accepted the message (`deliveryId`): a reload shows the user's message, the
 * line and a running turn, in that order. The message row is already accepted by `deliverMessage`.
 * Returns the rows so the open request can swap its draft for them.
 */
export async function persistAck(
  bot: BotRow,
  ack: { reply: string; slot: FastSlot },
  messageId: string,
  text: string,
  deliveryId: string,
  stages?: Stages
): Promise<FastRow[]> {
  // The slot is on the session the ack was drafted in. When eve took the message in a replacement
  // session (send.ts), the ack would land in the dead one and the chat would show the message twice.
  const [current] = await db()
    .select({ sessionId: bots.sessionId })
    .from(bots)
    .where(eq(bots.id, bot.id));
  if (current?.sessionId !== bot.sessionId) {
    throw new Error("session_replaced");
  }
  const rows = fastAckRows(ack.slot, messageId, text, ack.reply, deliveryId);
  const at = new Date();
  const sessionId = bot.sessionId as string;
  try {
    await span(
      "fast.persist",
      () =>
        db().transaction(async (tx) => {
          await consumeFastSlot(tx, sessionId, ack.slot, messageId);
          await tx.insert(events).values(
            rows.map((r) => ({
              at,
              botId: bot.id,
              data: r.data,
              index: r.index,
              line: r.line,
              sessionId,
              type: r.type,
            }))
          );
        }),
      stages
    );
  } catch (error) {
    await releaseFastSlot(sessionId, ack.slot, messageId);
    throw error;
  }
  return rows;
}

/**
 * Fast exchanges since the bot's last normal message before `before`: eve hasn't seen them. Once a
 * later normal message is accepted they fall out of this window, which is what marks them consumed.
 */
export async function pendingFastExchanges(
  botId: string,
  before: Date,
  limit = 10
): Promise<FastExchange[]> {
  const q = db();
  const [lastNormal] = await q
    .select({ at: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.botId, botId),
        eq(messages.status, "accepted"),
        notLike(messages.deliveryId, `${FAST_DELIVERY_PREFIX}%`),
        lt(messages.createdAt, before)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  const fast = await q
    .select({ id: messages.id, text: messages.text })
    .from(messages)
    .where(
      and(
        eq(messages.botId, botId),
        eq(messages.status, "accepted"),
        isNotNull(messages.deliveryId),
        like(messages.deliveryId, `${FAST_DELIVERY_PREFIX}%`),
        lt(messages.createdAt, before),
        ...(lastNormal ? [gt(messages.createdAt, lastNormal.at)] : [])
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  if (!fast.length) {
    return [];
  }
  const replies = await q
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.botId, botId),
        eq(events.type, "content.completed"),
        gte(events.index, FAST_INDEX_BASE),
        inArray(
          sql<string>`${events.data}->'scope'->>'turnId'`,
          fast.map((m) => fastTurnId(m.id))
        )
      )
    );
  const byTurn = new Map(
    replies.map((r) => {
      const fact = r.data as {
        data: { value?: unknown };
        scope: { turnId: string };
      };
      return [fact.scope.turnId, String(fact.data.value ?? "")];
    })
  );
  return fast.toReversed().flatMap((m) => {
    const reply = byTurn.get(fastTurnId(m.id));
    return reply ? [{ reply, text: m.text }] : [];
  });
}

/** The model's own status phrase, trimmed to one short line; anything else is dropped. */
export function statusOf(input: unknown): string | undefined {
  const raw = (input as { status?: unknown } | undefined)?.status;
  if (typeof raw !== "string") {
    return;
  }
  const line = raw.replace(SPACES, " ").replace(TRAILING_DOTS, "").trim();
  return line && line.length <= MAX_STATUS_CHARS ? line : undefined;
}
