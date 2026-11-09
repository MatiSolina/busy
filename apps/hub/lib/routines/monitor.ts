import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import {
  aiIssueFromEvent,
  aiIssueText,
  hasAiIssueSignal,
} from "@/lib/chat/model-errors";
import { sessionGone } from "@/lib/chat/send";
import { cursorOf, saver } from "@/lib/chat/store";
import { syncSession } from "@/lib/chat/sync";
import { bots, db, events, messages, routineRuns } from "@/lib/db";
import { readStream } from "@/lib/eve/client";
import { observeOperation } from "../operation-observability";
import { routineBotCall } from "./call";
import type { RoutineRunStatus } from "./types";

type JsonObject = Record<string, unknown>;
interface EventLike {
  data: JsonObject;
  scope?: JsonObject;
  type: string;
}

export interface RoutineTerminal {
  error: string | null;
  status: Extract<RoutineRunStatus, "succeeded" | "failed" | "cancelled">;
}

const SESSION_ENDED_ERROR =
  "The bot session ended before this routine could finish. Check the chat.";
const SESSION_UNAVAILABLE_ERROR =
  "The bot session is no longer available; this routine result could not be verified. Check the chat before running it again.";
const STREAM_FAILURE = /eve (?:stream|send) failed: (?:404|410)\b/u;
const SESSION_FAILURE = /"code"\s*:\s*"session_(?:not_active|stranded)"/u;

/** Definitive session loss is terminal; ordinary transport errors remain retryable. */
function sessionUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (sessionGone(error.message)) {
    return true;
  }
  return (
    STREAM_FAILURE.test(error.message) || SESSION_FAILURE.test(error.message)
  );
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Correlates one routine delivery with its own turn. A different turn settling in the same
 * session never completes this run. This stays pure so event ordering and idempotency are tested
 * independently from Postgres and eve transport.
 */
export function routineTerminalForEvents(
  deliveryId: string,
  rows: readonly EventLike[]
): RoutineTerminal | null {
  const delivery = rows.find(
    (row) =>
      row.type === "delivery.settled" &&
      string(row.data.deliveryId) === deliveryId
  );
  if (!delivery) {
    return null;
  }

  const deliveryOutcome = string(delivery.data.outcome);
  if (
    deliveryOutcome === "rejected" ||
    deliveryOutcome === "refused" ||
    deliveryOutcome === "ignored" ||
    deliveryOutcome === "failed"
  ) {
    return {
      error: "The routine delivery was not accepted.",
      status: "failed",
    };
  }
  // Eve closes a delivery as awaiting-input while its turn is paused. The later answer is a
  // different delivery, but it resumes this same turn; an exact turn.settled may therefore still
  // complete the original routine. A settlement for another turn never does.
  if (deliveryOutcome === "cancelled") {
    return { error: "The routine was cancelled.", status: "cancelled" };
  }

  const turnId = string(delivery.data.turnId) ?? string(delivery.scope?.turnId);
  if (!turnId) {
    return null;
  }
  const turn = rows.find((row) => {
    if (row.type !== "turn.settled") {
      return false;
    }
    const candidate = string(row.data.turnId) ?? string(row.scope?.turnId);
    return candidate === turnId;
  });
  if (!turn) {
    return null;
  }

  const outcome = string(turn.data.outcome);
  if (outcome === "completed") {
    return { error: null, status: "succeeded" };
  }
  if (outcome === "cancelled") {
    return { error: "The routine was cancelled.", status: "cancelled" };
  }
  const model = rows.find((row) => {
    if (row.type !== "model.settled" || !hasAiIssueSignal(row.data)) {
      return false;
    }
    const candidate = string(row.data.turnId) ?? string(row.scope?.turnId);
    return candidate === turnId;
  });
  if (model) {
    return {
      error: aiIssueText(aiIssueFromEvent(model.data)),
      status: "failed",
    };
  }
  if (hasAiIssueSignal(turn.data)) {
    return {
      error: aiIssueText(aiIssueFromEvent(turn.data)),
      status: "failed",
    };
  }
  return { error: "The routine turn failed.", status: "failed" };
}

/**
 * Look up only this occurrence in the persisted stream. This runs before remote I/O so a deleted,
 * expired, or otherwise unavailable eve session cannot hide a terminal fact already stored locally.
 */
export async function terminalFromStore(
  sessionId: string,
  deliveryId: string
): Promise<RoutineTerminal | null> {
  const [deliveryRow] = await db()
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        eq(events.type, "delivery.settled"),
        sql`${events.data}->'data'->>'deliveryId' = ${deliveryId}`
      )
    )
    .orderBy(asc(events.line), asc(events.index));
  const deliveryFact = deliveryRow ? factFromStored(deliveryRow.data) : null;
  const delivery =
    deliveryFact?.type === "delivery.settled" ? deliveryFact : null;
  if (delivery) {
    const immediate = routineTerminalForEvents(deliveryId, [delivery]);
    if (immediate) {
      return immediate;
    }
    const turnId =
      string(delivery.data.turnId) ?? string(delivery.scope?.turnId);
    if (turnId) {
      const settledTurns = await db()
        .select({ data: events.data, type: events.type })
        .from(events)
        .where(
          and(
            eq(events.sessionId, sessionId),
            or(
              eq(events.type, "turn.settled"),
              eq(events.type, "model.settled")
            ),
            sql`(${events.data}->'data'->>'turnId' = ${turnId} or ${events.data}->'scope'->>'turnId' = ${turnId})`
          )
        )
        .orderBy(asc(events.line), asc(events.index));
      const terminal = routineTerminalForEvents(deliveryId, [
        delivery,
        ...settledTurns.flatMap((row) => {
          const fact = factFromStored(row.data);
          return fact ? [fact] : [];
        }),
      ]);
      if (terminal) {
        return terminal;
      }
    }
  }
  return (await sessionEnded(sessionId))
    ? { error: SESSION_ENDED_ERROR, status: "failed" }
    : null;
}

/**
 * What one look at a routine run found. Only `terminal` and `session_gone` free the routine's slot:
 * a run whose session is alive stays `dispatched` however old it is, and a turn paused on a
 * question, approval or sign-in (`awaiting_input`) waits for the user instead of failing by age.
 */
export type RoutineObservation =
  | "awaiting_input"
  | "not_dispatched"
  | "running"
  | "session_gone"
  | "terminal";

/** Whether the observation released the run, as the durable workflow's step reports it. */
export const routineRunSettled = (observation: RoutineObservation) =>
  observation === "terminal" || observation === "session_gone";

/**
 * Whether this delivery's turn is paused on input nobody has answered yet. The delivery settles as
 * `awaiting-input` when its turn pauses; `turn.paused` lists the interactions it waits on and each
 * answer settles its interaction. Pure, so the event ordering is tested apart from Postgres.
 */
export function routineAwaitingInput(
  deliveryId: string,
  rows: readonly EventLike[]
): boolean {
  const delivery = rows.find(
    (row) =>
      row.type === "delivery.settled" &&
      string(row.data.deliveryId) === deliveryId
  );
  if (!delivery || string(delivery.data.outcome) !== "awaiting-input") {
    return false;
  }
  const turnId = string(delivery.data.turnId) ?? string(delivery.scope?.turnId);
  const pause = rows.findLast(
    (row) =>
      row.type === "turn.paused" &&
      turnId !== null &&
      (string(row.data.turnId) ?? string(row.scope?.turnId)) === turnId
  );
  const awaiting = Array.isArray(pause?.data.awaiting)
    ? pause.data.awaiting.flatMap((entry) => {
        const id = string(object(entry)?.interactionId);
        return id ? [id] : [];
      })
    : [];
  if (awaiting.length === 0) {
    return true; // the delivery says the turn paused; no pause fact narrows it down yet
  }
  const answered = new Set(
    rows.flatMap((row) => {
      const id =
        row.type === "interaction.settled"
          ? string(row.data.interactionId)
          : null;
      return id ? [id] : [];
    })
  );
  return awaiting.some((id) => !answered.has(id));
}

async function awaitingInputFromStore(
  sessionId: string,
  deliveryId: string
): Promise<boolean> {
  const rows = await db()
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        inArray(events.type, [
          "delivery.settled",
          "turn.paused",
          "interaction.settled",
        ])
      )
    )
    .orderBy(asc(events.line), asc(events.index));
  return routineAwaitingInput(
    deliveryId,
    rows.flatMap((row) => {
      const fact = factFromStored(row.data);
      return fact ? [fact] : [];
    })
  );
}

/** Sync the pinned session and mark the run once its exact delivery has settled. */
export async function refreshRoutineRun(
  runId: string,
  now = new Date()
): Promise<boolean> {
  return routineRunSettled(await observeRoutineRun(runId, now));
}

/**
 * Look at one run through the session pinned at admission. A run is failed only with evidence that
 * its session is gone (`session.ended`, 404/410 or an unavailable-session code from eve), and the
 * transition is conditional on the run still being `dispatched` on that same session.
 */
export async function observeRoutineRun(
  runId: string,
  now = new Date()
): Promise<RoutineObservation> {
  const [run] = await db()
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.id, runId));
  if (!run || (run.status !== "pending" && run.status !== "dispatched")) {
    return "terminal";
  }
  if (run.status === "pending" || !run.sessionId || !run.deliveryId) {
    return "not_dispatched";
  }
  const { botId, deliveryId, id, sessionId } = run;
  const monitoredRun = { botId, id, sessionId, startedAt: run.startedAt };

  // Dispatch persists the run before sending and inserts a pending chat message. If the process
  // died after Eve accepted the delivery but before the message update, repair that receipt before
  // any remote call. `messages.status` is transport state, not the task result.
  await db()
    .update(messages)
    .set({ deliveryId: run.deliveryId, status: "accepted" })
    .where(and(eq(messages.id, run.id), eq(messages.status, "pending")));

  const storedBeforeSync = await terminalFromStore(sessionId, deliveryId);
  if (storedBeforeSync) {
    return await finishMonitoredRun(monitoredRun, storedBeforeSync, now);
  }

  // The bot's current session can rotate after dispatch. Read the session captured on the run.
  const [bot] = await db().select().from(bots).where(eq(bots.id, run.botId));
  if (!bot) {
    return "running"; // no evidence about the session; the bot's own delete cascades its runs
  }
  try {
    await syncSession(
      {
        read: (start) =>
          readStream(routineBotCall(bot.slug, run.id), sessionId, start, false),
        save: saver(bot, sessionId, true),
      },
      await cursorOf(sessionId)
    );
  } catch (error) {
    if (!sessionUnavailable(error)) {
      throw error;
    }
    const observed = await finishMonitoredRun(
      monitoredRun,
      { error: SESSION_UNAVAILABLE_ERROR, status: "failed" },
      now
    );
    await retireUnavailableSession(run.botId, sessionId);
    return observed;
  }

  const terminal = await terminalFromStore(sessionId, deliveryId);
  if (terminal) {
    return await finishMonitoredRun(monitoredRun, terminal, now);
  }
  const awaiting = await awaitingInputFromStore(sessionId, deliveryId);
  // Observable sub-state only: the run stays `dispatched` either way.
  await db()
    .update(routineRuns)
    .set({
      awaitingInputAt: awaiting
        ? sql`coalesce(${routineRuns.awaitingInputAt}, ${now})`
        : null,
      lastObservedAt: now,
    })
    .where(
      and(
        eq(routineRuns.id, id),
        eq(routineRuns.status, "dispatched"),
        eq(routineRuns.sessionId, sessionId)
      )
    );
  return awaiting ? "awaiting_input" : "running";
}

function factFromStored(value: unknown): EventLike | null {
  const fact = object(value);
  if (!fact || typeof fact.type !== "string") {
    return null;
  }
  const data = object(fact.data);
  if (!data) {
    return null;
  }
  return { data, scope: object(fact.scope) ?? undefined, type: fact.type };
}

/**
 * Close a run that is still `dispatched` on the session it was admitted to. A terminal recorded
 * first (by the workflow, the queue consumer or the cron sweep) wins: this then changes nothing.
 */
async function finishRoutineRun(
  run: { id: string; sessionId: string },
  terminal: RoutineTerminal,
  now: Date
): Promise<boolean> {
  const rows = await db()
    .update(routineRuns)
    .set({
      error: terminal.error,
      finishedAt: now,
      status: terminal.status,
    })
    .where(
      and(
        eq(routineRuns.id, run.id),
        eq(routineRuns.status, "dispatched"),
        eq(routineRuns.sessionId, run.sessionId)
      )
    )
    .returning({ id: routineRuns.id });
  return rows.length > 0;
}

/**
 * Retire a session only while it is still the bot's current session. A newer
 * session may have been installed while this monitor was reading the old
 * one; the equality predicate makes that replacement win the race.
 */
async function retireUnavailableSession(
  botId: string,
  sessionId: string
): Promise<void> {
  await db()
    .update(bots)
    .set({ historyPending: false, sessionId: null })
    .where(and(eq(bots.id, botId), eq(bots.sessionId, sessionId)));
}

async function finishMonitoredRun(
  run: { botId: string; id: string; sessionId: string; startedAt: Date | null },
  terminal: RoutineTerminal,
  now: Date
): Promise<RoutineObservation> {
  const gone =
    terminal.error === SESSION_ENDED_ERROR ||
    terminal.error === SESSION_UNAVAILABLE_ERROR;
  const won = await finishRoutineRun(run, terminal, now);
  if (!won) {
    // Someone else recorded the outcome first; report what is stored now.
    const [current] = await db()
      .select({ status: routineRuns.status })
      .from(routineRuns)
      .where(eq(routineRuns.id, run.id));
    return current?.status === "dispatched" ? "running" : "terminal";
  }
  let outcome: "completed" | "failed" | "skipped" = "failed";
  if (terminal.status === "succeeded") {
    outcome = "completed";
  } else if (terminal.status === "cancelled") {
    outcome = "skipped";
  }
  observeOperation({
    botId: run.botId,
    durationMs: run.startedAt
      ? Math.max(0, now.getTime() - run.startedAt.getTime())
      : null,
    entryPoint: "workflow",
    flow: "routine",
    operationId: run.id,
    outcome,
    sessionId: run.sessionId,
    stage: "terminal",
  });
  if (terminal.error === SESSION_ENDED_ERROR) {
    await retireUnavailableSession(run.botId, run.sessionId);
  }
  return gone ? "session_gone" : "terminal";
}

async function sessionEnded(sessionId: string): Promise<boolean> {
  const [row] = await db()
    .select({ data: events.data })
    .from(events)
    .where(
      and(eq(events.sessionId, sessionId), eq(events.type, "session.ended"))
    )
    .orderBy(asc(events.line), asc(events.index));
  return (
    row !== undefined && factFromStored(row.data)?.type === "session.ended"
  );
}

/**
 * The workflow observes a run every 15 s for about two hours. A run nobody observed for this long
 * was left by it (finished or lost), and only this sweep looks at it from then on.
 */
const SWEEP_AFTER_MS = 10 * 60_000;
const SWEEP_LIMIT = 25;

export interface RoutineRecovery {
  awaitingInput: number;
  checked: number;
  errors: number;
  released: number;
  running: number;
}

/**
 * Cron sweep for `dispatched` runs the workflow stopped following. Each run is observed through
 * its own pinned session: it is released only on evidence that the session is gone or a terminal
 * fact for its delivery. A run that is still working, or waiting for the user's answer, stays
 * `dispatched` however old it is, so the next occurrence is skipped instead of opening a second
 * writer on the same computer.
 */
export async function recoverRoutineRuns(
  now = new Date()
): Promise<RoutineRecovery> {
  const observed = sql`coalesce(${routineRuns.lastObservedAt}, ${routineRuns.startedAt})`;
  const stale = await db()
    .select({ id: routineRuns.id })
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.status, "dispatched"),
        // An explicit timestamptz: postgres.js cannot type a JS Date compared with a raw expression.
        sql`${observed} < ${new Date(now.getTime() - SWEEP_AFTER_MS).toISOString()}::timestamptz`
      )
    )
    .orderBy(asc(observed))
    .limit(SWEEP_LIMIT);
  const results = await Promise.allSettled(
    stale.map((run) => observeRoutineRun(run.id, now))
  );
  const summary: RoutineRecovery = {
    awaitingInput: 0,
    checked: stale.length,
    errors: 0,
    released: 0,
    running: 0,
  };
  for (const result of results) {
    if (result.status === "rejected") {
      summary.errors += 1;
    } else if (routineRunSettled(result.value)) {
      summary.released += 1;
    } else if (result.value === "awaiting_input") {
      summary.awaitingInput += 1;
    } else {
      summary.running += 1;
    }
  }
  return summary;
}
