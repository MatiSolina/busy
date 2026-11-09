import { randomUUID } from "node:crypto";
import {
  Schedules,
  SchedulesApiError,
  type SchedulesClient,
} from "@vercel/schedules";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db, type RoutineRow, routineScheduleOutbox, routines } from "@/lib/db";
import { syncRoutineSchedule } from "./schedule";

export type RoutineScheduleAction = "upsert" | "disable" | "delete";

type Database = ReturnType<typeof db>;
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type OutboxRow = typeof routineScheduleOutbox.$inferSelect;

/**
 * A claim outlives the call holding it: no Vercel function runs longer than 800 s (`maxDuration`),
 * so by the time another worker can take an expired lease the first one has been stopped. Vercel
 * offers no fencing token for schedules; this bound is what keeps two calls for one routine apart.
 */
const LEASE_MS = 15 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const BATCH = 25;
const ERROR_CODE = /^[a-z_]{1,64}$/u;

/** What the routine row asks of its Vercel schedule. A routine that no longer exists is deleted. */
export function scheduleAction(
  row: Pick<RoutineRow, "deletedAt" | "enabled"> | undefined
): RoutineScheduleAction {
  if (!row || row.deletedAt) {
    return "delete";
  }
  return row.enabled ? "upsert" : "disable";
}

/**
 * Record the routine's desired schedule in the caller's transaction, after its generation was
 * bumped. One job per routine: a newer generation replaces an older one that has not been applied,
 * and an older generation never replaces a newer one. The running worker's lease is kept, so a
 * second worker cannot call Vercel for this routine until the first one has finished.
 */
export async function enqueueRoutineSchedule(
  tx: DbTransaction,
  row: Pick<
    RoutineRow,
    "botId" | "deletedAt" | "enabled" | "id" | "scheduleGeneration"
  >,
  now: Date
): Promise<void> {
  await tx
    .insert(routineScheduleOutbox)
    .values({
      action: scheduleAction(row),
      botId: row.botId,
      generation: row.scheduleGeneration,
      nextAttemptAt: now,
      routineId: row.id,
    })
    .onConflictDoUpdate({
      set: {
        action: sql`excluded.action`,
        appliedAt: null,
        attempts: 0,
        generation: sql`excluded.generation`,
        lastError: null,
        nextAttemptAt: sql`excluded.next_attempt_at`,
        status: "pending",
        updatedAt: now,
      },
      // A deleted routine never comes back, so a non-delete after a delete is a new routine that
      // reuses the id of one removed with its bot; its generation restarts.
      setWhere: sql`${routineScheduleOutbox.generation} < excluded.generation or (${routineScheduleOutbox.action} = 'delete' and excluded.action <> 'delete')`,
      target: routineScheduleOutbox.routineId,
    });
}

export interface RoutineScheduleRun {
  applied: number;
  failed: number;
  superseded: number;
}

/**
 * Apply due schedule jobs. Each job is claimed with `FOR UPDATE SKIP LOCKED` and a lease in one
 * short statement; Vercel is called after that statement committed, never inside a transaction.
 * The job is marked applied only if its generation is still current and the lease is still ours.
 */
export async function processRoutineScheduleOutbox({
  client = Schedules,
  limit = BATCH,
  now = new Date(),
  routineId,
}: {
  client?: SchedulesClient;
  limit?: number;
  now?: Date;
  routineId?: string;
} = {}): Promise<RoutineScheduleRun> {
  const jobs = await claim(now, limit, routineId);
  const outcomes = await Promise.all(
    jobs.map((job) => applyJob(job, client, now))
  );
  return {
    applied: outcomes.filter((outcome) => outcome === "applied").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    superseded: outcomes.filter((outcome) => outcome === "superseded").length,
  };
}

/** Apply one routine's job right after its transaction committed. The cron retries what fails. */
export async function syncRoutineScheduleAfterCommit(
  routineId: string
): Promise<void> {
  try {
    await processRoutineScheduleOutbox({ limit: 1, routineId });
  } catch {
    // The job is durable: `/api/cron/routines` claims it again.
    console.error("routine schedule sync deferred to the cron");
  }
}

/**
 * Cron reconciliation: make sure every routine has a job for its current generation (routines
 * saved by code older than the outbox), turn jobs of routines removed with their bot into deletes,
 * forget deletes already applied for rows that are gone, then apply what is due.
 */
export async function reconcileRoutineSchedules(
  now = new Date(),
  client: SchedulesClient = Schedules
): Promise<RoutineScheduleRun> {
  await db().execute(sql`
    INSERT INTO routine_schedule_outbox (routine_id, bot_id, generation, action, next_attempt_at)
    SELECT r.id, r.bot_id, r.schedule_generation,
      CASE WHEN r.deleted_at IS NOT NULL THEN 'delete' WHEN NOT r.enabled THEN 'disable' ELSE 'upsert' END,
      ${now}
    FROM routines r
    LEFT JOIN routine_schedule_outbox o ON o.routine_id = r.id
    WHERE o.routine_id IS NULL OR o.generation < r.schedule_generation
    ON CONFLICT (routine_id) DO UPDATE SET
      action = excluded.action, generation = excluded.generation, status = 'pending',
      attempts = 0, last_error = NULL, applied_at = NULL,
      next_attempt_at = excluded.next_attempt_at, updated_at = ${now}
    WHERE routine_schedule_outbox.generation < excluded.generation
  `);
  await db().execute(sql`
    UPDATE routine_schedule_outbox o
    SET action = 'delete', status = 'pending', attempts = 0, next_attempt_at = ${now}, updated_at = ${now}
    WHERE o.action <> 'delete'
      AND NOT EXISTS (SELECT 1 FROM routines r WHERE r.id = o.routine_id)
  `);
  await db().execute(sql`
    DELETE FROM routine_schedule_outbox o
    WHERE o.status = 'applied' AND o.action = 'delete'
      AND NOT EXISTS (SELECT 1 FROM routines r WHERE r.id = o.routine_id)
  `);
  return await processRoutineScheduleOutbox({ client, now });
}

async function claim(
  now: Date,
  limit: number,
  routineId: string | undefined
): Promise<OutboxRow[]> {
  const due = and(
    eq(routineScheduleOutbox.status, "pending"),
    lte(routineScheduleOutbox.nextAttemptAt, now),
    or(
      isNull(routineScheduleOutbox.leaseUntil),
      lt(routineScheduleOutbox.leaseUntil, now)
    ),
    routineId ? eq(routineScheduleOutbox.routineId, routineId) : undefined
  );
  const candidates = db()
    .select({ routineId: routineScheduleOutbox.routineId })
    .from(routineScheduleOutbox)
    .where(due)
    .orderBy(asc(routineScheduleOutbox.nextAttemptAt))
    .limit(limit)
    .for("update", { skipLocked: true });
  return await db()
    .update(routineScheduleOutbox)
    .set({
      attempts: sql`${routineScheduleOutbox.attempts} + 1`,
      leaseToken: randomUUID(),
      leaseUntil: new Date(now.getTime() + LEASE_MS),
      updatedAt: now,
    })
    .where(and(inArray(routineScheduleOutbox.routineId, candidates), due))
    .returning();
}

async function applyJob(
  job: OutboxRow,
  client: SchedulesClient,
  now: Date
): Promise<"applied" | "failed" | "superseded"> {
  const lease = job.leaseToken;
  if (!lease) {
    return "superseded";
  }
  const [routine] = await db()
    .select()
    .from(routines)
    .where(eq(routines.id, job.routineId));
  const action = scheduleAction(routine);
  try {
    await syncRoutineSchedule(
      routine ?? {
        // Removed with its bot: only the stable schedule identity is needed to delete it.
        botId: job.botId,
        daysOfWeek: [0],
        deletedAt: now,
        enabled: false,
        id: job.routineId,
        time: "00:00",
        timeZone: "UTC",
      },
      client
    );
  } catch (error) {
    const delay = Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** (job.attempts - 1));
    await db()
      .update(routineScheduleOutbox)
      .set({
        lastError: errorCode(error),
        leaseToken: null,
        leaseUntil: null,
        nextAttemptAt: new Date(now.getTime() + delay),
        updatedAt: now,
      })
      .where(
        and(
          eq(routineScheduleOutbox.routineId, job.routineId),
          eq(routineScheduleOutbox.leaseToken, lease)
        )
      );
    return "failed";
  }
  // A create or enable only counts while its routine still exists at this generation; otherwise
  // the job stays pending and the next pass applies what the row asks for now (a delete wins).
  const current =
    action === "delete"
      ? undefined
      : sql`exists (select 1 from ${routines} where ${routines.id} = ${routineScheduleOutbox.routineId} and ${routines.deletedAt} is null and ${routines.scheduleGeneration} = ${routineScheduleOutbox.generation})`;
  const [applied] = await db()
    .update(routineScheduleOutbox)
    .set({
      action,
      appliedAt: now,
      attempts: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
      status: "applied",
      updatedAt: now,
    })
    .where(
      and(
        eq(routineScheduleOutbox.routineId, job.routineId),
        eq(routineScheduleOutbox.generation, job.generation),
        eq(routineScheduleOutbox.leaseToken, lease),
        current
      )
    )
    .returning({ routineId: routineScheduleOutbox.routineId });
  if (applied) {
    return "applied";
  }
  await db()
    .update(routineScheduleOutbox)
    .set({ leaseToken: null, leaseUntil: null, nextAttemptAt: now })
    .where(
      and(
        eq(routineScheduleOutbox.routineId, job.routineId),
        eq(routineScheduleOutbox.leaseToken, lease)
      )
    );
  return "superseded";
}

/** Providers can echo request details in messages; keep only a fixed code. */
function errorCode(error: unknown): string {
  if (
    error instanceof SchedulesApiError &&
    typeof error.code === "string" &&
    ERROR_CODE.test(error.code)
  ) {
    return `schedules_${error.code}`;
  }
  return "schedule_sync_failed";
}
