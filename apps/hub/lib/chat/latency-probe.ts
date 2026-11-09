import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_BOTS } from "@/evals/performance/production-config";
import { getBot } from "@/lib/bots/service";
import {
  deliverMessage,
  ensureMessage,
  followTurn,
  type MessagePayload,
  markMessageFailed,
  payloadHash,
} from "./deliver";
import { errorCodeOf, logChatObservation } from "./observability";
import { syncBot } from "./store";
import { type ChatTraceTimeline, loadChatTrace } from "./trace-query";

export const PROBE_BOTS = DEFAULT_BOTS;
export const PROBE_WAIT_MS = 60_000;
const POLL_MS = 3000;

const ms = (value: string | null | undefined) =>
  value ? Date.parse(value) : Number.NaN;
const lag = (from: number, to: string | null | undefined) => {
  const value = ms(to) - from;
  return Number.isFinite(value) ? value : undefined;
};

function sampleFields(startedAt: number, trace: ChatTraceTimeline | null) {
  if (!trace) {
    return {};
  }
  const { delivery, modelAttempts, turn } = trace.stages;
  const [model] = modelAttempts;
  const usage = trace.usage.totals ?? model?.usage ?? null;
  return {
    // Hub request start → eve delivery.admitted (different clocks: small skew is possible).
    admittedLagMs: lag(startedAt, delivery.admittedAt),
    cachedTokens: usage?.cacheReadTokens ?? undefined,
    // Hub request start → turn.settled: what a user waits for the full answer.
    durationMs: lag(startedAt, turn.endAt),
    inputTokens: usage?.inputTokens ?? undefined,
    modelMs: model?.durationMs ?? undefined,
    modelQueueMs: model?.queueDurationMs ?? undefined,
    outputTokens: usage?.outputTokens ?? undefined,
    provider: model?.provider ?? undefined,
    sessionId: trace.correlation.sessionId ?? undefined,
    turnMs: turn.durationMs ?? undefined,
    turnStartLagMs: lag(ms(delivery.admittedAt), turn.startAt),
    turnToModelMs: model?.turnToModelMs ?? undefined,
  };
}

/**
 * Sends one synthetic message through the same path as POST /api/bots/[slug]/messages, then
 * follows its persisted turn until it settles or `waitMs` runs out. Logs one allowlisted line;
 * never the prompt or the answer.
 */
export async function probeBot(slug: string, waitMs = PROBE_WAIT_MS) {
  const startedAt = Date.now();
  // Negative or non-finite durations (clock skew, missing events) are dropped by the logger.
  const log = (
    outcome: string,
    fields: Record<string, number | string | undefined> = {}
  ) =>
    logChatObservation("latency.probe", { botSlug: slug, outcome, ...fields });
  const bot = await getBot(slug);
  if (!bot) {
    return log("not_found");
  }
  if (bot.status !== "ready") {
    return log("not_ready");
  }
  const id = randomUUID();
  const marker = `BUSY_PROBE_${randomUUID().replaceAll("-", "")}`;
  const payload: MessagePayload = {
    botId: bot.id,
    clientContext: { timeZone: "UTC" },
    fileIds: [],
    selectedSkills: [],
    text: `This is a synthetic Busy latency probe. Respond with exactly ${marker} and nothing else. Do not call tools, read files, or perform external actions.`,
  };
  let deliveryId: string;
  try {
    const resolution = await ensureMessage(
      bot.id,
      id,
      payload,
      payloadHash(payload)
    );
    if ("error" in resolution) {
      return log("conflict", { messageId: id });
    }
    ({ deliveryId } = await deliverMessage({
      bot,
      fileIds: [],
      id,
      messageContext: payload.clientContext,
      stages: {},
      text: payload.text,
    }));
  } catch (error) {
    await markMessageFailed(id, error).catch(() => undefined);
    return log("failed", { errorCode: errorCodeOf(error), messageId: id });
  }
  const ackMs = Date.now() - startedAt;
  await followTurn(bot, deliveryId);

  let trace: ChatTraceTimeline | null = null;
  try {
    const deadline = startedAt + waitMs;
    while (Date.now() < deadline) {
      // biome-ignore lint/performance/noAwaitInLoops: bounded sequential polling of one turn.
      await sleep(POLL_MS);
      // sendToBot may have opened a new session: sync whatever the bot points to now.
      const current = await getBot(slug);
      if (current) {
        await syncBot(current);
      }
      trace = await loadChatTrace(bot, id);
      if (trace?.stages.turn.endAt) {
        break;
      }
    }
  } catch (error) {
    return log("failed", {
      ackMs,
      deliveryId,
      errorCode: errorCodeOf(error),
      messageId: id,
      ...sampleFields(startedAt, trace),
    });
  }
  const settled = Boolean(trace?.stages.turn.endAt);
  return log(
    settled ? (trace?.stages.turn.outcome ?? "completed") : "timeout",
    { ackMs, deliveryId, messageId: id, ...sampleFields(startedAt, trace) }
  );
}

/** One sample per allowlisted QA bot, in parallel. Each failure is logged, never thrown. */
export async function runLatencyProbe(waitMs = PROBE_WAIT_MS) {
  const results = await Promise.allSettled(
    PROBE_BOTS.map((slug) => probeBot(slug, waitMs))
  );
  return {
    bots: PROBE_BOTS.length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}
