import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  bots,
  db,
  type RoutineRow,
  type RoutineRunRow,
  routineRuns,
  routines,
} from "@/lib/db";
import {
  enqueueRoutineSchedule,
  syncRoutineScheduleAfterCommit,
} from "./outbox";
import {
  type PublicRoutine,
  type PublicRoutineRun,
  RoutineConflictError,
  RoutineNotFoundError,
  type RoutineSkipReason,
} from "./types";
import type { RoutineInput, RoutinePatch } from "./validation";

const owned = (botId: string, id: string) =>
  and(
    eq(routines.botId, botId),
    eq(routines.id, id),
    isNull(routines.deletedAt)
  );

export function publicRun(row: RoutineRunRow): PublicRoutineRun {
  return {
    awaitingInputSince:
      row.status === "dispatched" && row.awaitingInputAt
        ? row.awaitingInputAt.toISOString()
        : null,
    deliveryId: row.deliveryId,
    error: row.error,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    id: row.id,
    scheduledFor: row.scheduledFor.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    status: row.status,
  };
}

function publicRoutine(
  row: RoutineRow,
  lastRun?: RoutineRunRow
): PublicRoutine {
  return {
    daysOfWeek: row.daysOfWeek,
    enabled: row.enabled,
    id: row.id,
    lastRun: lastRun ? publicRun(lastRun) : null,
    name: row.name,
    prompt: row.prompt,
    skipped: {
      count: row.skippedOccurrences,
      lastAt: row.lastSkippedAt?.toISOString() ?? null,
      lastReason: row.lastSkipReason ?? null,
    },
    time: row.time,
    timeZone: row.timeZone,
  };
}

/**
 * Count an occurrence that was not run, with its reason, so a routine whose previous run never
 * finishes does not look healthy while it silently skips every schedule.
 */
export async function recordSkippedOccurrence(
  routineId: string,
  reason: RoutineSkipReason,
  now: Date
): Promise<void> {
  await db()
    .update(routines)
    .set({
      lastSkippedAt: now,
      lastSkipReason: reason,
      skippedOccurrences: sql`${routines.skippedOccurrences} + 1`,
    })
    .where(eq(routines.id, routineId));
}

async function latestRun(id: string): Promise<RoutineRunRow | undefined> {
  const [row] = await db()
    .select()
    .from(routineRuns)
    .where(eq(routineRuns.routineId, id))
    .orderBy(desc(routineRuns.scheduledFor))
    .limit(1);
  return row;
}

export async function listRoutines(botId: string): Promise<PublicRoutine[]> {
  const rows = await db()
    .select()
    .from(routines)
    .where(and(eq(routines.botId, botId), isNull(routines.deletedAt)))
    .orderBy(asc(routines.createdAt), asc(routines.id));
  if (!rows.length) {
    return [];
  }
  const runs = await db()
    .selectDistinctOn([routineRuns.routineId])
    .from(routineRuns)
    .where(
      inArray(
        routineRuns.routineId,
        rows.map((r) => r.id)
      )
    )
    .orderBy(routineRuns.routineId, desc(routineRuns.scheduledFor));
  const byRoutine = new Map(runs.map((r) => [r.routineId, r]));
  return rows.map((r) => publicRoutine(r, byRoutine.get(r.id)));
}

export async function createRoutine(
  botId: string,
  input: RoutineInput,
  now = new Date()
): Promise<PublicRoutine> {
  const row = await db().transaction(async (tx) => {
    // Serialize creates and their capacity check for this bot.
    const [bot] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.id, botId))
      .for("update");
    if (!bot) {
      throw new RoutineNotFoundError();
    }
    const [existing] = await tx
      .select()
      .from(routines)
      .where(eq(routines.id, input.id));
    const daysOfWeek = [...input.daysOfWeek].sort();
    if (existing) {
      if (
        existing.botId !== botId ||
        existing.deletedAt ||
        existing.name !== input.name ||
        existing.prompt !== input.prompt ||
        existing.time !== input.time ||
        existing.timeZone !== input.timeZone ||
        JSON.stringify(existing.daysOfWeek) !== JSON.stringify(daysOfWeek)
      ) {
        throw new RoutineConflictError(
          "This request id already belongs to a different routine."
        );
      }
      // A retried create: its schedule job was written with the row and is applied below.
      return existing;
    }
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(routines)
      .where(and(eq(routines.botId, botId), isNull(routines.deletedAt)));
    if (count >= 100) {
      throw new RoutineConflictError(
        "This bot already has 100 routines. Remove one before adding another."
      );
    }
    const [created] = await tx
      .insert(routines)
      .values({ ...input, botId, daysOfWeek })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      throw new RoutineConflictError(
        "This request id already belongs to a different routine."
      );
    }
    // The schedule job commits with the routine; Vercel is called only after the commit.
    await enqueueRoutineSchedule(tx, created, now);
    return created;
  });
  await syncRoutineScheduleAfterCommit(row.id);
  return publicRoutine(row, await latestRun(row.id));
}

export async function updateRoutine(
  botId: string,
  id: string,
  patch: RoutinePatch,
  now = new Date()
): Promise<PublicRoutine> {
  const row = await db().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(routines)
      .where(owned(botId, id))
      .for("update");
    if (!existing) {
      throw new RoutineNotFoundError();
    }
    const changes = {
      ...patch,
      ...(patch.daysOfWeek ? { daysOfWeek: [...patch.daysOfWeek].sort() } : {}),
    };
    const [updated] = await tx
      .update(routines)
      .set({
        ...changes,
        scheduleGeneration: sql`${routines.scheduleGeneration} + 1`,
        updatedAt: now,
      })
      .where(owned(botId, id))
      .returning();
    // Once a session has been pinned the message may already be admitted: never pretend to cancel it.
    await tx
      .update(routineRuns)
      .set({
        finishedAt: now,
        status: "cancelled",
      })
      .where(
        and(
          eq(routineRuns.routineId, id),
          eq(routineRuns.status, "pending"),
          isNull(routineRuns.sessionId)
        )
      );
    if (!updated) {
      throw new Error("Routine update did not return a row");
    }
    await enqueueRoutineSchedule(tx, updated, now);
    return updated;
  });
  await syncRoutineScheduleAfterCommit(id);
  return publicRoutine(row, await latestRun(id));
}

export async function deleteRoutine(
  botId: string,
  id: string,
  now = new Date()
): Promise<void> {
  await db().transaction(async (tx) => {
    const [row] = await tx
      .select({ id: routines.id })
      .from(routines)
      .where(owned(botId, id))
      .for("update");
    if (!row) {
      throw new RoutineNotFoundError();
    }
    // Retain already accepted occurrences for deduplication, completion and audit.
    const [deleted] = await tx
      .update(routines)
      .set({
        deletedAt: now,
        enabled: false,
        scheduleGeneration: sql`${routines.scheduleGeneration} + 1`,
        updatedAt: now,
      })
      .where(owned(botId, id))
      .returning();
    if (deleted) {
      await enqueueRoutineSchedule(tx, deleted, now);
    }
    await tx
      .update(routineRuns)
      .set({
        finishedAt: now,
        status: "cancelled",
      })
      .where(
        and(
          eq(routineRuns.routineId, id),
          eq(routineRuns.status, "pending"),
          isNull(routineRuns.sessionId)
        )
      );
  });
  await syncRoutineScheduleAfterCommit(id);
}

export function routineMessage(row: RoutineRow, scheduledFor: Date): string {
  return [
    "<routine_execution>",
    `Scheduled task: ${row.name.replace(/\s+/gu, " ")}`,
    `Scheduled for: ${scheduledFor.toISOString()} (${row.timeZone}, ${row.time} local time).`,
    "Execute the saved task below now, using your currently connected tools, MCPs, skills and computer as needed. This is an existing routine firing, not a request to create or reschedule a routine. Report the result in this chat and send deliverable files with send_file. If a connection or human input is required, explain what is needed; never claim the task was completed without evidence.",
    "</routine_execution>",
    "",
    row.prompt,
  ].join("\n");
}
