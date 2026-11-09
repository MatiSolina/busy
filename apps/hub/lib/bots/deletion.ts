import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { requestBotCodeTaskShutdown } from "../code-tasks/bot-deletion";
import { type BotRow, bots, botTombstones, db } from "../db";
import { need } from "../env";
import { deleteBotBlobs } from "../files";
import { deleteOrphanedLibraryObjects } from "../library-objects";
import { deleteBotSchedules } from "../routines/schedule";
import { deleteProject, projectId } from "../vercel/client";

/**
 * Durable bot deletion (H-11; docs/library-content.md).
 *
 * 1. `requestBotDeletion` marks the live row `deleting` with a token in one conditional UPDATE. The
 *    row keeps its slug reserved (a new bot gets a suffix) and refuses uploads/promotions.
 * 2. `deleteBotWorkflow` runs the steps below. Each one re-reads the row by id + token, is idempotent
 *    and uses stable handles: the Vercel project is deleted only by the id captured once, schedules by
 *    the bot-id namespace and Blobs by the id prefix (plus the legacy slug prefix, reference-checked).
 * 3. `finalizeBotDeletion` writes a separate tombstone and hard-deletes the row; owned data cascades
 *    (drizzle/0029), consultations other bots opened towards it keep a NULL receiver.
 * 4. Failures are recorded on the row with backoff; the library verification cron restarts due
 *    deletions (`claimDueBotDeletions`), and after `DELETION_MAX_ATTEMPTS` the row stays visible as
 *    `attention` until someone deletes it again (the safe administrative retry).
 */

export const DELETION_MAX_ATTEMPTS = 8;
/** How long a started run owns a deletion before the cron may start another one. */
const DELETION_LEASE_MINUTES = 15;
const NO_PROJECT = "none";

export type CodeTaskShutdown = (botId: string) => Promise<{ pending: number }>;

export interface DeletionDeps {
  deleteBlobs: (bot: Pick<BotRow, "id" | "slug">) => Promise<void>;
  deleteProjectById: (id: string) => Promise<void>;
  deleteSchedules: (botId: string) => Promise<void>;
  /** The id of the Vercel project with this name, or null when there is none. */
  lookupProjectId: (name: string) => Promise<string | null>;
  requestBotCodeTaskShutdown?: CodeTaskShutdown;
}

const NOT_FOUND = /failed: 404\b/u;

export function defaultDeletionDeps(): DeletionDeps {
  const cfg = () => ({
    teamId: need("VERCEL_TEAM_ID"),
    token: need("VERCEL_TOKEN"),
  });
  return {
    deleteBlobs: deleteBotBlobs,
    // DELETE /v9/projects/{idOrName} with an id; a 404 (already gone) is success.
    deleteProjectById: (id) => deleteProject(cfg(), id),
    deleteSchedules: deleteBotSchedules,
    lookupProjectId: async (name) => {
      try {
        return await projectId(cfg(), name);
      } catch (error) {
        if (error instanceof Error && NOT_FOUND.test(error.message)) {
          return null;
        }
        throw error;
      }
    },
    requestBotCodeTaskShutdown,
  };
}

/** Prefix that survives the step boundary (only the message crosses it): waiting, not failing. */
export const NOT_READY_PREFIX = "not ready: ";

/** A step that cannot finish yet (code tasks still stopping, a project recreated): retried later. */
export class DeletionNotReadyError extends Error {
  constructor(message: string) {
    super(`${NOT_READY_PREFIX}${message}`);
    this.name = "DeletionNotReadyError";
  }
}

/** Waiting on something that is still stopping retries every few minutes without using an attempt. */
const NOT_READY_RETRY_MINUTES = 5;

export const projectName = (slug: string) => `bot-${slug}`;

/**
 * Mark the bot `deleting` (or re-arm an `attention` one). Idempotent: a second request keeps the
 * token. `start` says whether the caller should launch the workflow now, false while another run
 * holds the lease. Returns null when the bot no longer exists.
 */
export async function requestBotDeletion(
  botId: string
): Promise<{ start: boolean; token: string } | null> {
  const lease = sql`now() + make_interval(mins => ${DELETION_LEASE_MINUTES})`;
  const returning = { token: bots.deletionToken };
  // A live bot: mark it. The UPDATE takes the row lock that registerFile shares, so a reservation
  // commits before the mark or sees it.
  const [marked] = await db()
    .update(bots)
    .set({
      deletionAttempts: 0,
      deletionNextAttemptAt: lease,
      deletionRequestedAt: sql`now()`,
      deletionState: "deleting",
      deletionToken: sql`gen_random_uuid()`,
      updatedAt: new Date(),
    })
    .where(and(eq(bots.id, botId), isNull(bots.deletionState)))
    .returning(returning);
  // A deletion that needs attention (or whose run's lease expired): retry it with the same token.
  const [rearmed] = marked
    ? [marked]
    : await db()
        .update(bots)
        .set({
          deletionAttempts: sql`case when ${bots.deletionState} = 'attention' then 0 else ${bots.deletionAttempts} end`,
          deletionNextAttemptAt: lease,
          deletionState: "deleting",
        })
        .where(
          and(
            eq(bots.id, botId),
            sql`(${bots.deletionState} = 'attention' or (${bots.deletionState} = 'deleting' and ${bots.deletionNextAttemptAt} <= now()))`
          )
        )
        .returning(returning);
  if (rearmed?.token) {
    return { start: true, token: rearmed.token };
  }
  // Otherwise a run holds the lease: the request is accepted without starting another one.
  const [inFlight] = await db()
    .select(returning)
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.deletionState, "deleting")));
  return inFlight?.token ? { start: false, token: inFlight.token } : null;
}

/** Deletions whose run died, failed or was never started, leased to the caller (the cron). */
export async function claimDueBotDeletions(
  limit = 10
): Promise<Array<{ botId: string; token: string }>> {
  const due = await db()
    .select({ id: bots.id })
    .from(bots)
    .where(
      and(
        eq(bots.deletionState, "deleting"),
        lte(bots.deletionNextAttemptAt, sql`now()`)
      )
    )
    .limit(Math.min(Math.max(limit, 1), 50));
  const claimed: Array<{ botId: string; token: string }> = [];
  for (const { id } of due) {
    // biome-ignore lint/performance/noAwaitInLoops: Each claim is its own conditional UPDATE; losers are skipped.
    const [row] = await db()
      .update(bots)
      .set({
        deletionNextAttemptAt: sql`now() + make_interval(mins => ${DELETION_LEASE_MINUTES})`,
      })
      .where(
        and(
          eq(bots.id, id),
          eq(bots.deletionState, "deleting"),
          lte(bots.deletionNextAttemptAt, sql`now()`)
        )
      )
      .returning({ token: bots.deletionToken });
    if (row?.token) {
      claimed.push({ botId: id, token: row.token });
    }
  }
  return claimed;
}

/** The row while this deletion still owns it; null when it finished, was superseded or needs attention. */
export async function deletingBot(
  botId: string,
  token: string
): Promise<BotRow | null> {
  const [row] = await db()
    .select()
    .from(bots)
    .where(
      and(
        eq(bots.id, botId),
        eq(bots.deletionToken, token),
        eq(bots.deletionState, "deleting")
      )
    );
  return row ?? null;
}

/** Step 1: no code task of the bot may keep running or publishing once its row goes (H-25). */
export async function stopBotCodeTasks(
  bot: BotRow,
  deps: DeletionDeps
): Promise<void> {
  if (!deps.requestBotCodeTaskShutdown) {
    return;
  }
  const { pending } = await deps.requestBotCodeTaskShutdown(bot.id);
  if (pending > 0) {
    throw new DeletionNotReadyError(`${pending} code tasks still stopping`);
  }
}

/**
 * Step 2: the Vercel project, only ever by id. The id is captured once while this row still reserves
 * the slug (no other bot can own `bot-<slug>` then) and stored on the row, so a retry deletes the same
 * project even if the name later points elsewhere. If a project with the name reappears with another
 * id (a deploy of this bot that was already in flight recreated it), that id is captured and the step
 * retries; it never deletes by name.
 */
export async function deleteBotProject(
  bot: BotRow,
  token: string,
  deps: DeletionDeps
): Promise<void> {
  const name = projectName(bot.slug);
  let handle = bot.deletionProjectId;
  if (!handle) {
    // The project the bot's identity is bound to (0028) when there is one; otherwise the name,
    // which only this row can own while it reserves the slug.
    const found =
      bot.vercelProjectId ?? (await deps.lookupProjectId(name)) ?? NO_PROJECT;
    await db()
      .update(bots)
      .set({ deletionProjectId: found })
      .where(
        and(
          eq(bots.id, bot.id),
          eq(bots.deletionToken, token),
          isNull(bots.deletionProjectId)
        )
      );
    const current = await deletingBot(bot.id, token);
    handle = current?.deletionProjectId ?? null;
    if (!handle) {
      throw new DeletionNotReadyError("deletion superseded");
    }
  }
  if (handle !== NO_PROJECT) {
    await deps.deleteProjectById(handle);
  }
  const reappeared = await deps.lookupProjectId(name);
  if (reappeared && reappeared !== handle) {
    await db()
      .update(bots)
      .set({ deletionProjectId: reappeared })
      .where(
        and(
          eq(bots.id, bot.id),
          eq(bots.deletionToken, token),
          eq(bots.deletionProjectId, handle)
        )
      );
    throw new DeletionNotReadyError("bot project was recreated");
  }
}

/**
 * Last step: tombstone, then the hard delete, in one short transaction fenced by the token. Returns
 * false when another run already finished it (the second run is a no-op).
 */
export async function finalizeBotDeletion(
  botId: string,
  token: string
): Promise<boolean> {
  return await db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(bots)
      .where(
        and(
          eq(bots.id, botId),
          eq(bots.deletionToken, token),
          eq(bots.deletionState, "deleting")
        )
      )
      .for("update");
    if (!row) {
      return false;
    }
    await tx
      .insert(botTombstones)
      .values({
        botCreatedAt: row.createdAt,
        botId: row.id,
        deletionRequestedAt: row.deletionRequestedAt ?? new Date(),
        slug: row.slug,
        vercelProjectId:
          row.deletionProjectId && row.deletionProjectId !== NO_PROJECT
            ? row.deletionProjectId
            : row.vercelProjectId,
      })
      .onConflictDoNothing();
    // events, cursors, messages, files, memories and its own consultations cascade; consultations
    // other bots opened towards it keep a NULL receiver; code tasks keep a NULL bot (0021/0029).
    await tx.delete(bots).where(eq(bots.id, botId));
    return true;
  });
}

/** After the hard delete: collect library objects whose last reference went with the bot's files. */
export async function collectAfterDeletion(): Promise<number> {
  return await deleteOrphanedLibraryObjects();
}

/**
 * A failed run: record it with backoff; past the attempt limit the row needs attention. A run that
 * only waited (code tasks still confirming their stop, a project recreated) keeps its attempts: a
 * slow but healthy stop never turns the deletion into `attention`.
 */
export async function recordBotDeletionFailure(
  botId: string,
  token: string,
  message: string
): Promise<void> {
  const fence = and(
    eq(bots.id, botId),
    eq(bots.deletionToken, token),
    eq(bots.deletionState, "deleting")
  );
  if (message.startsWith(NOT_READY_PREFIX)) {
    await db()
      .update(bots)
      .set({
        deletionLastError: message.slice(0, 500),
        deletionNextAttemptAt: sql`now() + make_interval(mins => ${NOT_READY_RETRY_MINUTES})`,
      })
      .where(fence);
    return;
  }
  await db()
    .update(bots)
    .set({
      deletionAttempts: sql`${bots.deletionAttempts} + 1`,
      deletionLastError: message.slice(0, 500),
      deletionNextAttemptAt: sql`now() + make_interval(mins => least(60, power(2, ${bots.deletionAttempts})::int))`,
      deletionState: sql`case when ${bots.deletionAttempts} + 1 >= ${DELETION_MAX_ATTEMPTS} then 'attention' else 'deleting' end`,
    })
    .where(
      and(
        eq(bots.id, botId),
        eq(bots.deletionToken, token),
        eq(bots.deletionState, "deleting")
      )
    );
}

export const DELETION_STAGES = [
  "code-tasks",
  "project",
  "schedules",
  "blobs",
] as const;
export type DeletionStage = (typeof DELETION_STAGES)[number];

/**
 * One idempotent effect of the deletion, re-reading the row by id + token first: when the deletion
 * already finished or was superseded it does nothing and returns null, so the caller stops.
 */
export async function runDeletionStage(
  botId: string,
  token: string,
  stage: DeletionStage,
  deps: DeletionDeps
): Promise<{ slug: string } | null> {
  const bot = await deletingBot(botId, token);
  if (!bot) {
    return null;
  }
  if (stage === "code-tasks") {
    await stopBotCodeTasks(bot, deps);
  } else if (stage === "project") {
    await deleteBotProject(bot, token, deps);
  } else if (stage === "schedules") {
    // Before the row: its routines' rows cascade with the bot, their Vercel schedules do not.
    await deps.deleteSchedules(bot.id);
  } else {
    await deps.deleteBlobs(bot);
  }
  return { slug: bot.slug };
}

/** Whether a deleted bot's row is gone (the late Blob sweep runs only then). */
export async function botRowGone(botId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.id, botId));
  return !row;
}
