import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { and, eq, inArray } from "drizzle-orm";
import { start } from "workflow/api";
import { sessionGone } from "@/lib/chat/send";
import {
  replaceMainSession,
  SessionOpeningInProgress,
} from "@/lib/chat/session";
import {
  bots,
  db,
  messages,
  type RoutineRow,
  type RoutineRunRow,
  routineRuns,
  routines,
} from "@/lib/db";
import { sendMessage } from "@/lib/eve/client";
import { routineRunWorkflow } from "@/workflows/routine-run";
import {
  observeOperation,
  operationErrorCode,
} from "../operation-observability";
import { routineBotCall } from "./call";
import { refreshRoutineRun } from "./monitor";
import { isRoutineSchedule } from "./schedule";
import { recordSkippedOccurrence, routineMessage } from "./store";
import type { RoutineSkipReason } from "./types";

const MAX_ATTEMPTS = 5;
/** The queue redelivers about once a minute (see the consumer route); give a busy bot ~30 minutes. */
export const MAX_DELIVERIES = 30;

/** One Vercel Schedules execution of a routine, as read from its queue message. */
export interface RoutineOccurrence {
  executionId: string;
  routineId: string;
  scheduledAt: Date;
  scheduleId: string;
}

/** Thrown to make the queue redeliver the occurrence later. */
export class RoutineRetryError extends Error {}

/**
 * Every delivery of one execution maps to the same run id, which is also eve's message
 * idempotency key: a duplicate delivery can neither add a run nor send the prompt twice.
 */
export function routineRunId(executionId: string): string {
  const hex = createHash("sha256")
    .update(`busy:routine-execution:${executionId}`)
    .digest("hex");
  // Shaped as an RFC 4122 v5 UUID so it passes the run-id checks used for bot tokens.
  const variant = ((Number.parseInt(hex[16] ?? "0", 16) % 4) + 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_MS = 24 * 60 * 60_000;

/**
 * Whether `at` is one of the routine's own occurrences, recent enough to still run. The consumer
 * route is reachable over HTTP, so a forged message could at most run a routine at a time it was
 * due anyway (and the real execution then dedupes on the occurrence). It also drops executions
 * published before an edit moved the routine to another time.
 */
export function isRoutineOccurrence(
  routine: Pick<RoutineRow, "daysOfWeek" | "time" | "timeZone">,
  at: Date,
  now = new Date()
): boolean {
  const age = now.getTime() - at.getTime();
  if (at.getUTCSeconds() !== 0 || age < -60_000 || age > DAY_MS) {
    return false;
  }
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      timeZone: routine.timeZone,
      weekday: "short",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value])
  );
  return (
    `${parts.hour}:${parts.minute}` === routine.time &&
    routine.daysOfWeek.includes(WEEKDAYS.indexOf(parts.weekday ?? ""))
  );
}

/**
 * Persist the destination BEFORE sending. A retry can never replay the occurrence into another
 * session. A bot without a session gets one from the main-session helper between two short
 * transactions: no row lock is held while eve creates it (H-43), the opening is reserved so a
 * concurrent chat or Live adopts the same session, and the install is a compare-and-set.
 */
async function prepareRun(runId: string, now: Date) {
  const first = await pinRun(runId, now, null);
  if (first?.kind !== "open") {
    return first;
  }
  let main: Awaited<ReturnType<typeof replaceMainSession>>;
  try {
    main = await replaceMainSession(first.bot, null, {
      call: routineBotCall(first.bot.slug, runId),
    });
  } catch (error) {
    if (error instanceof SessionOpeningInProgress) {
      throw new RoutineRetryError("The bot's session is being opened.", {
        cause: error,
      });
    }
    throw error;
  }
  const pinned = await pinRun(runId, now, main.sessionId);
  return pinned?.kind === "open" ? null : pinned;
}

/**
 * One short transaction: locks the occurrence and pins it to its session (its own, the bot's, or
 * `opened`, the session the helper just installed or adopted). `open` when there is none yet.
 */
async function pinRun(runId: string, now: Date, opened: string | null) {
  return await db().transaction(async (tx) => {
    const [run] = await tx
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, runId));
    if (!run) {
      return null;
    }
    // Same lock order as edit/delete: routine first, occurrence second.
    const [routine] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, run.routineId))
      .for("update");
    const [locked] = await tx
      .select()
      .from(routineRuns)
      .where(eq(routineRuns.id, runId))
      .for("update");
    if (locked?.status !== "pending") {
      return null;
    }
    if (!locked.sessionId && (!routine?.enabled || routine.deletedAt)) {
      await tx
        .update(routineRuns)
        .set({ finishedAt: now, status: "cancelled" })
        .where(eq(routineRuns.id, locked.id));
      return null;
    }
    // No FOR UPDATE on the bot: nothing here writes it, and eve is never called in this transaction.
    const [bot] = await tx.select().from(bots).where(eq(bots.id, locked.botId));
    if (bot?.status !== "ready") {
      throw new RoutineRetryError("The bot is not ready yet.");
    }
    // A pinned occurrence keeps its session; otherwise the bot's current one, which is the winner
    // of the helper's install when `opened` is set (never the helper's own result if it lost).
    const sessionId = locked.sessionId ?? bot.sessionId;
    if (!sessionId) {
      if (opened) {
        throw new RoutineRetryError("The bot's new session was retired again.");
      }
      return { bot, kind: "open" as const };
    }
    const [prepared] = await tx
      .update(routineRuns)
      .set({ attempts: locked.attempts + 1, sessionId })
      .where(eq(routineRuns.id, locked.id))
      .returning();
    await tx
      .insert(messages)
      .values({
        attempt: 1,
        botId: bot.id,
        id: locked.id,
        sessionId,
        text: locked.prompt,
      })
      .onConflictDoNothing();
    if (!prepared) {
      return null;
    }
    return { bot, kind: "ready" as const, run: prepared, sessionId };
  });
}

/**
 * Send a pending run to its bot. Returns true once eve accepted it. Throws (after recording the
 * error) when the same occurrence should be retried by the queue.
 */
export async function dispatchRoutineRun(
  runId: string,
  now = new Date()
): Promise<boolean> {
  const startedAt = performance.now();
  const observe = (
    fields: Partial<Parameters<typeof observeOperation>[0]> & {
      outcome: Parameters<typeof observeOperation>[0]["outcome"];
    }
  ) =>
    observeOperation({
      durationMs: performance.now() - startedAt,
      entryPoint: "cron",
      flow: "routine",
      operationId: runId,
      stage: "dispatch",
      ...fields,
    });
  let prepared: Awaited<ReturnType<typeof prepareRun>>;
  try {
    prepared = await prepareRun(runId, now);
  } catch (error) {
    observe({ errorCode: operationErrorCode(error), outcome: "failed" });
    throw error;
  }
  if (!prepared) {
    observe({ outcome: "skipped" });
    return false;
  }
  const { bot, run, sessionId } = prepared;
  try {
    const { deliveryId } = await sendMessage(
      routineBotCall(bot.slug, run.id),
      sessionId,
      { files: [], id: run.id, text: run.prompt, turnPolicy: "queue" }
    );
    // Do not regress a terminal row if a concurrent delivery already recorded completion.
    const [accepted] = await db()
      .update(routineRuns)
      .set({ deliveryId, error: null, startedAt: now, status: "dispatched" })
      .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "pending")))
      .returning();
    if (accepted) {
      await db()
        .update(messages)
        .set({ deliveryId, status: "accepted" })
        .where(eq(messages.id, run.id));
    }
    observe({
      botId: bot.id,
      outcome: accepted ? "accepted" : "skipped",
      provider: bot.billing,
      sessionId,
    });
    return Boolean(accepted);
  } catch (error) {
    const retry = await recordSendFailure(run, sessionId, error, now);
    observe({
      botId: bot.id,
      errorCode: operationErrorCode(error),
      outcome: "failed",
      sessionId,
    });
    if (retry) {
      throw new RoutineRetryError(retry, { cause: error });
    }
    return false;
  }
}

/** Close a still-pending run as failed, with its chat message. */
async function failRun(runId: string, error: string, now: Date) {
  const [failed] = await db()
    .update(routineRuns)
    .set({ error, finishedAt: now, status: "failed" })
    .where(and(eq(routineRuns.id, runId), eq(routineRuns.status, "pending")))
    .returning();
  if (failed) {
    await db()
      .update(messages)
      .set({ status: "failed" })
      .where(and(eq(messages.id, runId), eq(messages.status, "pending")));
  }
}

/** Record a failed send. Returns the error to retry with, or null when the run is now failed. */
async function recordSendFailure(
  run: RoutineRunRow,
  sessionId: string,
  error: unknown,
  now: Date
): Promise<string | null> {
  const gone = error instanceof Error && sessionGone(error.message);
  if (gone) {
    // The next occurrence may open a fresh session; this occurrence is never sent there again.
    await db()
      .update(bots)
      .set({ historyPending: false, sessionId: null })
      .where(and(eq(bots.id, run.botId), eq(bots.sessionId, sessionId)));
  }
  // Providers may put credentials in errors. Persist only an actionable, fixed message.
  if (gone || run.attempts >= MAX_ATTEMPTS) {
    await failRun(
      run.id,
      gone
        ? "The bot's session is no longer available. Check the chat before running the task again."
        : "Delivery could not be confirmed after several attempts. Check the chat before running the task again.",
      now
    );
    return null;
  }
  const retry =
    "Could not reach the bot. Busy will retry this same occurrence.";
  await db()
    .update(routineRuns)
    .set({ error: retry })
    .where(and(eq(routineRuns.id, run.id), eq(routineRuns.status, "pending")));
  return retry;
}

/** Why an occurrence found no slot: an earlier run still holds it, or this time already ran. */
async function skipReason(routineId: string): Promise<RoutineSkipReason> {
  const [active] = await db()
    .select({ awaitingInputAt: routineRuns.awaitingInputAt })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.routineId, routineId),
        inArray(routineRuns.status, ["pending", "dispatched"])
      )
    );
  if (!active) {
    return "duplicate_occurrence";
  }
  return active.awaitingInputAt ? "awaiting_input" : "active_run";
}

/**
 * Handle one queue delivery of a routine's schedule execution: record the run (deduplicated by
 * execution id), send it to the bot and start the workflow that follows it to completion.
 * Throwing makes the queue redeliver; every step is safe to repeat.
 */
export async function runRoutineOccurrence(
  occurrence: RoutineOccurrence,
  deliveryCount = 1,
  now = new Date()
): Promise<RoutineRunRow["status"] | "skipped"> {
  const id = routineRunId(occurrence.executionId);
  let [run] = await db()
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.id, id));
  if (!run) {
    const [routine] = await db()
      .select()
      .from(routines)
      .where(eq(routines.id, occurrence.routineId));
    // A schedule can outlive its routine for a moment (or its bot, whose rows cascade).
    if (
      !routine?.enabled ||
      routine.deletedAt ||
      !isRoutineOccurrence(routine, occurrence.scheduledAt, now) ||
      !(await isRoutineSchedule(routine, occurrence.scheduleId))
    ) {
      return "skipped";
    }
    // One active run per routine. Give a previous one a chance to settle before this one is skipped.
    const [active] = await db()
      .select({ id: routineRuns.id })
      .from(routineRuns)
      .where(
        and(
          eq(routineRuns.routineId, routine.id),
          inArray(routineRuns.status, ["pending", "dispatched"])
        )
      );
    if (active) {
      await refreshRoutineRun(active.id).catch(() => false);
    }
    await db()
      .insert(routineRuns)
      .values({
        botId: routine.botId,
        id,
        prompt: routineMessage(routine, occurrence.scheduledAt),
        routineId: routine.id,
        scheduledFor: occurrence.scheduledAt,
      })
      .onConflictDoNothing();
    [run] = await db().select().from(routineRuns).where(eq(routineRuns.id, id));
    if (!run) {
      await recordSkippedOccurrence(
        routine.id,
        await skipReason(routine.id),
        now
      );
      return "skipped";
    }
  }
  if (run.status === "pending") {
    if (deliveryCount > MAX_DELIVERIES) {
      await failRun(
        run.id,
        "The bot was not available to run this routine. It will run again at its next scheduled time.",
        now
      );
      return "failed";
    }
    await dispatchRoutineRun(run.id, now);
    [run] = await db().select().from(routineRuns).where(eq(routineRuns.id, id));
  }
  if (run?.status === "dispatched") {
    // A redelivery may start a second follower; refreshRoutineRun is idempotent, so that is harmless.
    await start(routineRunWorkflow, [run.id]);
  }
  return run?.status ?? "skipped";
}
