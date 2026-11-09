import { randomUUID } from "node:crypto";
import { and, eq, isNull, lt, max, sql } from "drizzle-orm";
import { type BotRow, botSessionOpenings, botSessions, bots, db } from "../db";
import { type BotCall, createSession, endSession } from "../eve/client";
import { observeOperation } from "../operation-observability";

/**
 * The bot's main session (docs/acceptance.md, "One main session per bot"). Every writer that opens
 * one (Live, a chat send, a deploy refresh, a routine) goes through `replaceMainSession`:
 *
 * 1. a short reservation per bot (`bot_session_openings`), committed before eve is called, so two
 *    openers never both create one and no row lock is held across HTTP;
 * 2. `createSession` with a deterministic operationId (`<bot>:main:<generation>`), so a retry after
 *    a crash, or a worker that reclaims an expired reservation, gets the same session back;
 * 3. a compare-and-set install (`session_id IS NOT DISTINCT FROM observed`) that also registers the
 *    session's generation. A writer that loses adopts the winner. A session eve created for a loser
 *    is registered in `bot_sessions` without a generation and ended; `endOrphanSessions` retries
 *    the end until eve confirms it, so it never stays a second writer of the bot's Drive.
 */

type BotRef = Pick<BotRow, "id" | "slug">;

export interface SessionDeps {
  createSession: typeof createSession;
  endSession: typeof endSession;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const defaults: SessionDeps = {
  createSession,
  endSession,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A reservation outlives a crashed opener by this much; then another may reclaim it. */
const OPENING_LEASE_SECONDS = 60;
/** How long a caller waits for another opener before giving up with a retryable error. */
export const OPENING_WAIT_MS = 20_000;
const OPENING_POLL_MS = 250;

/** Another writer is opening this bot's session; retry shortly (N-06 `session_opening`). */
export class SessionOpeningInProgress extends Error {
  override name = "SessionOpeningInProgress";
}

/** `session_id IS NOT DISTINCT FROM observed`, the guard of every main-session transition. */
const holds = (observed: string | null) =>
  observed === null ? isNull(bots.sessionId) : eq(bots.sessionId, observed);

async function readBot(botId: string): Promise<BotRow | null> {
  const [row] = await db().select().from(bots).where(eq(bots.id, botId));
  return row ?? null;
}

/** Clears a dead session, never one that replaced it after the caller read it. */
export async function retireSession(
  botId: string,
  sessionId: string
): Promise<boolean> {
  const rows = await db()
    .update(bots)
    .set({ historyPending: false, sessionId: null })
    .where(and(eq(bots.id, botId), eq(bots.sessionId, sessionId)))
    .returning({ id: bots.id });
  return rows.length > 0;
}

/**
 * The first message of a session that still owes its history takes the duty: exactly one sender
 * seeds it. `restoreHistory` gives it back when that send fails.
 */
export async function claimHistory(
  botId: string,
  sessionId: string
): Promise<boolean> {
  const rows = await db()
    .update(bots)
    .set({ historyPending: false })
    .where(
      and(
        eq(bots.id, botId),
        eq(bots.sessionId, sessionId),
        eq(bots.historyPending, true)
      )
    )
    .returning({ id: bots.id });
  return rows.length > 0;
}

export async function restoreHistory(
  botId: string,
  sessionId: string
): Promise<void> {
  await db()
    .update(bots)
    .set({ historyPending: true })
    .where(and(eq(bots.id, botId), eq(bots.sessionId, sessionId)));
}

interface Opening {
  generation: number;
  operationId: string;
  token: string;
}

/** Takes the bot's opening reservation, or null while another opener holds a live one. */
async function reserveOpening(botId: string): Promise<Opening | null> {
  const [last] = await db()
    .select({ generation: max(botSessions.generation) })
    .from(botSessions)
    .where(eq(botSessions.botId, botId));
  const generation = (last?.generation ?? 0) + 1;
  const opening = {
    generation,
    operationId: `${botId}:main:${generation}`,
    token: randomUUID(),
  };
  const leaseUntil = sql`now() + make_interval(secs => ${OPENING_LEASE_SECONDS})`;
  const [row] = await db()
    .insert(botSessionOpenings)
    .values({ botId, ...opening, leaseUntil })
    .onConflictDoUpdate({
      // Reclaiming an expired reservation keeps its operationId: eve hands back the session the
      // crashed opener may have created instead of a second one.
      set: { createdAt: sql`now()`, leaseUntil, token: opening.token },
      setWhere: lt(botSessionOpenings.leaseUntil, sql`now()`),
      target: botSessionOpenings.botId,
    })
    .returning({
      generation: botSessionOpenings.generation,
      operationId: botSessionOpenings.operationId,
      token: botSessionOpenings.token,
    });
  return row?.token === opening.token ? row : null;
}

/**
 * The bot's next generation, computed when the session is installed: chat recovery (session
 * recoveries, lib/chat/send.ts) installs main sessions too, so a number taken at reservation time
 * could already be used.
 */
const nextGeneration = (botId: string) =>
  sql<number>`(select coalesce(max(bs.generation), 0) + 1 from ${botSessions} bs where bs.bot_id = ${botId})`;

/**
 * Registers a main session installed by chat recovery after its compare-and-set won. A conflict
 * leaves it unregistered (ordered by time in the history) rather than failing the delivery.
 */
export async function registerMainSession(
  botId: string,
  sessionId: string,
  operationId: string
): Promise<void> {
  await db()
    .insert(botSessions)
    .values({
      botId,
      generation: nextGeneration(botId),
      operationId,
      sessionId,
    })
    .onConflictDoNothing();
}

/** Records a session that will not be installed, before ending it: `endOrphanSessions` retries. */
export async function trackOrphanSession(
  botId: string,
  sessionId: string,
  operationId: string
): Promise<void> {
  await db()
    .insert(botSessions)
    .values({ botId, operationId, sessionId })
    .onConflictDoNothing();
}

export async function markSessionEnded(sessionId: string): Promise<void> {
  await db()
    .update(botSessions)
    .set({ endedAt: new Date() })
    .where(
      and(eq(botSessions.sessionId, sessionId), isNull(botSessions.generation))
    );
}

/** Releases only this caller's reservation, never one a later opener took over. */
async function releaseOpening(botId: string, token: string): Promise<void> {
  await db()
    .delete(botSessionOpenings)
    .where(
      and(
        eq(botSessionOpenings.botId, botId),
        eq(botSessionOpenings.token, token)
      )
    );
}

type Finish =
  | { kind: "won"; row: BotRow }
  | { kind: "adopt"; row: BotRow }
  | { kind: "orphan"; row: BotRow | null }
  | { kind: "stale" };

/** The install: one short transaction after eve answered. */
function finishOpening(
  botId: string,
  observed: string | null,
  created: string,
  opening: Opening
): Promise<Finish> {
  return db().transaction(async (tx): Promise<Finish> => {
    const [mine] = await tx
      .delete(botSessionOpenings)
      .where(
        and(
          eq(botSessionOpenings.botId, botId),
          eq(botSessionOpenings.token, opening.token)
        )
      )
      .returning({ token: botSessionOpenings.token });
    if (!mine) {
      // Our lease expired and another opener reclaimed it with the same operationId: eve gives it
      // this same session, so it is that opener's to install. Never end it from here.
      return { kind: "stale" };
    }
    const install = (from: string | null) =>
      tx
        .update(bots)
        .set({ historyPending: true, sessionId: created })
        .where(and(eq(bots.id, botId), holds(from)))
        .returning();
    // A dead session someone cleared meanwhile leaves nothing to replace: ours still goes in.
    let [won] = await install(observed);
    if (!won && observed !== null) {
      [won] = await install(null);
    }
    if (won) {
      await tx
        .insert(botSessions)
        .values({
          botId,
          generation: nextGeneration(botId),
          operationId: opening.operationId,
          sessionId: created,
        })
        .onConflictDoUpdate({
          set: { endedAt: null, generation: nextGeneration(botId) },
          target: botSessions.sessionId,
        });
      return { kind: "won", row: won };
    }
    const [current] = await tx.select().from(bots).where(eq(bots.id, botId));
    if (current?.sessionId === created) {
      return { kind: "adopt", row: current };
    }
    // Ours lost: record it before anyone can forget it, so a sweeper can end it after a crash.
    await tx
      .insert(botSessions)
      .values({ botId, operationId: opening.operationId, sessionId: created })
      .onConflictDoNothing();
    return { kind: "orphan", row: current ?? null };
  });
}

/** Ends a session that lost its install. False leaves it for `endOrphanSessions`. */
export async function abandonSession(
  bot: BotRef,
  call: BotCall,
  sessionId: string,
  deps: Pick<SessionDeps, "endSession"> = defaults
): Promise<boolean> {
  const ended = await deps
    .endSession(call, sessionId, "busy: lost main-session install")
    .catch(() => false);
  await db()
    .update(botSessions)
    .set(
      ended
        ? { endedAt: new Date() }
        : { endAttempts: sql`${botSessions.endAttempts} + 1` }
    )
    .where(
      and(eq(botSessions.sessionId, sessionId), isNull(botSessions.generation))
    );
  observeOperation({
    botId: bot.id,
    entryPoint: "internal",
    flow: "live",
    operationId: `abandon:${sessionId}`,
    outcome: ended ? "completed" : "pending",
    sessionId,
    stage: "session",
  });
  return ended;
}

export interface MainSession {
  bot: BotRow;
  /** This call's session won the install (false: it adopted another writer's). */
  opened: boolean;
  sessionId: string;
}

/**
 * Replaces `observed` (null: the bot has none) with a new main session, or adopts the one another
 * writer installed meanwhile. A new session owes its history to its first message. Throws
 * `SessionOpeningInProgress` when another opener holds the reservation past `OPENING_WAIT_MS`.
 */
export async function replaceMainSession(
  bot: BotRef,
  observed: string | null,
  options: { call: BotCall; deps?: Partial<SessionDeps> }
): Promise<MainSession> {
  const deps = { ...defaults, ...options.deps };
  const deadline = deps.now() + OPENING_WAIT_MS;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each pass re-reads what the last opener did.
    const outcome = await openOnce(bot, observed, options.call, deps);
    if (outcome !== "busy" && outcome !== "again") {
      return outcome;
    }
    if (outcome === "busy") {
      if (deps.now() >= deadline) {
        throw new SessionOpeningInProgress(
          "The bot's session is being opened; try again."
        );
      }
      await deps.sleep(OPENING_POLL_MS);
    }
  }
}

const adopt = (row: BotRow): MainSession => ({
  bot: row,
  opened: false,
  sessionId: row.sessionId as string,
});

/**
 * One pass: adopt, or reserve → create → install. `busy`: another opener holds the reservation.
 * `again`: our reservation went stale, or the bot lost its session meanwhile.
 */
async function openOnce(
  bot: BotRef,
  observed: string | null,
  call: BotCall,
  deps: SessionDeps
): Promise<MainSession | "again" | "busy"> {
  const before = await readBot(bot.id);
  if (!before) {
    throw new Error("The bot no longer exists.");
  }
  if (before.sessionId && before.sessionId !== observed) {
    return adopt(before);
  }
  const opening = await reserveOpening(bot.id);
  if (!opening) {
    return "busy";
  }
  const startedAt = deps.now();
  let created: string;
  try {
    created = await deps.createSession(call, opening.operationId);
  } catch (error) {
    await releaseOpening(bot.id, opening.token).catch(() => undefined);
    throw error;
  }
  const finish = await finishOpening(
    bot.id,
    before.sessionId,
    created,
    opening
  );
  observeOperation({
    botId: bot.id,
    durationMs: deps.now() - startedAt,
    entryPoint: "internal",
    flow: "live",
    operationId: opening.operationId,
    outcome: finish.kind === "won" ? "completed" : "skipped",
    sessionId: created,
    stage: "session",
  });
  if (finish.kind === "won") {
    return { bot: finish.row, opened: true, sessionId: created };
  }
  if (finish.kind === "adopt") {
    return adopt(finish.row);
  }
  if (finish.kind === "orphan") {
    await abandonSession(bot, call, created, deps);
    if (finish.row?.sessionId) {
      return adopt(finish.row);
    }
  }
  return "again";
}

/** The bot's main session, opened when it has none (`ready` with no session is a normal state). */
export async function ensureMainSession(
  bot: BotRow,
  options: { call: BotCall; deps?: Partial<SessionDeps> }
): Promise<MainSession> {
  if (bot.sessionId) {
    return { bot, opened: false, sessionId: bot.sessionId };
  }
  return await replaceMainSession(bot, null, options);
}

/**
 * Ends the sessions that lost an install and were not confirmed ended (a crash, or eve down at the
 * time). Safe to run twice: an ended session answers 404/410/session_not_active, which counts.
 */
export async function endOrphanSessions(
  call: (slug: string) => BotCall,
  deps: Pick<SessionDeps, "endSession"> = defaults,
  limit = 20
): Promise<{ ended: number; pending: number }> {
  const orphans = await db()
    .select({
      botId: bots.id,
      sessionId: botSessions.sessionId,
      slug: bots.slug,
    })
    .from(botSessions)
    .innerJoin(bots, eq(bots.id, botSessions.botId))
    .where(
      and(
        isNull(botSessions.generation),
        isNull(botSessions.endedAt),
        // Never the bot's live session, whatever the registry says.
        sql`${bots.sessionId} is distinct from ${botSessions.sessionId}`,
        lt(botSessions.createdAt, sql`now() - interval '1 minute'`)
      )
    )
    .orderBy(botSessions.createdAt)
    .limit(limit);
  let ended = 0;
  for (const orphan of orphans) {
    // biome-ignore lint/performance/noAwaitInLoops: a few sessions per run, ended one by one.
    const done = await abandonSession(
      { id: orphan.botId, slug: orphan.slug },
      call(orphan.slug),
      orphan.sessionId,
      deps
    );
    ended += done ? 1 : 0;
  }
  return { ended, pending: orphans.length - ended };
}
