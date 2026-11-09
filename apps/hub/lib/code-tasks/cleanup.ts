import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getWorld } from "durable-harness";
import {
  type DeletedSessionSandbox,
  deleteSessionSandbox,
} from "durable-harness/sandbox";
import { codeTaskCommands, codeTaskEvents, codeTasks, db } from "@/lib/db";

type SandboxWorld = NonNullable<
  NonNullable<Parameters<typeof deleteSessionSandbox>[1]>["world"]
>;

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;
const TERMINAL_STATUSES = [
  "cancelled",
  "failed",
  "needs_attention",
  "ready",
] as const;
// Only commands that dispatch can still deliver block cleanup. An accepted or
// applied command of a task terminal for the whole retention window has no
// live turn left to settle it: it is an orphan, reconciled below.
const PENDING_COMMAND_STATUSES = ["leased", "queued"] as const;
const ORPHAN_COMMAND_STATUSES = ["accepted", "applied"] as const;
const TERMINAL_RUN_STATUSES = ["cancelled", "completed", "failed"] as const;
const NOT_FOUND = /not found/iu;

interface CleanupTask {
  execution: Record<string, unknown>;
  id: string;
  leaseToken: string;
  sessionId: string;
}

export interface CodeTaskCleanupOptions {
  deleteSandbox?: typeof deleteSessionSandbox;
  limit?: number;
  now?: Date;
  world?: SandboxWorld;
}

export interface CodeTaskCleanupResult {
  deleted: Array<{
    id: string;
    sessionId: string;
    result: DeletedSessionSandbox;
  }>;
  examined: number;
  failed: Array<{ id: string; sessionId: string; error: string }>;
  kept: number;
}

function executionWithDeletion(
  execution: Record<string, unknown>,
  at: Date
): Record<string, unknown> {
  return {
    ...execution,
    workspaceDeletedAt: at.toISOString(),
  };
}

/**
 * Delete old task workspaces without touching a live or resumable task.
 *
 * The database lease is acquired before the external delete and released with
 * a compare-and-swap. `force` is intentionally never used: durable-harness
 * refuses an open fx run, which is the safe outcome for a task that resumed
 * between candidate selection and deletion.
 */
export async function cleanupCodeTaskWorkspaces(
  options: CodeTaskCleanupOptions = {}
): Promise<CodeTaskCleanupResult> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const remove = options.deleteSandbox ?? deleteSessionSandbox;
  const world = options.world ?? (await getWorld());
  const result: CodeTaskCleanupResult = {
    deleted: [],
    examined: 0,
    failed: [],
    kept: 0,
  };

  const candidates = await db()
    .select({
      execution: codeTasks.execution,
      id: codeTasks.id,
      sessionId: codeTasks.durableSessionId,
    })
    .from(codeTasks)
    .where(
      and(
        inArray(codeTasks.status, [...TERMINAL_STATUSES]),
        lt(codeTasks.finishedAt, cutoff),
        or(isNull(codeTasks.leaseToken), lt(codeTasks.leaseUntil, now)),
        sql`${codeTasks.durableSessionId} is not null`,
        sql`${codeTasks.finishedAt} is not null`,
        sql`not (${codeTasks.execution} ? 'workspaceDeletedAt')`
      )
    )
    .limit(limit);

  for (const candidate of candidates) {
    result.examined += 1;
    // biome-ignore lint/performance/noAwaitInLoops: each reservation must be serialized before deleting an external workspace.
    const task = await reserveCleanupTask(candidate.id, cutoff, now);
    if (!task) {
      result.kept += 1;
      continue;
    }
    try {
      await closeWorldRun(world, task.sessionId);
      const deleted = await remove(task.sessionId, { force: false, world });
      await markCleanupComplete(task, now);
      result.deleted.push({
        id: task.id,
        result: deleted,
        sessionId: task.sessionId,
      });
    } catch {
      await releaseCleanupLease(task.id, task.leaseToken);
      result.failed.push({
        error: "The task workspace could not be cleaned up.",
        id: task.id,
        sessionId: task.sessionId,
      });
    }
  }
  return result;
}

function reserveCleanupTask(
  id: string,
  cutoff: Date,
  now: Date
): Promise<CleanupTask | null> {
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select({
        execution: codeTasks.execution,
        finishedAt: codeTasks.finishedAt,
        id: codeTasks.id,
        leaseToken: codeTasks.leaseToken,
        leaseUntil: codeTasks.leaseUntil,
        sessionId: codeTasks.durableSessionId,
        status: codeTasks.status,
      })
      .from(codeTasks)
      .where(eq(codeTasks.id, id))
      .for("update");
    if (!task) {
      return null;
    }
    if (
      !(task.sessionId && task.finishedAt) ||
      task.finishedAt >= cutoff ||
      !(TERMINAL_STATUSES as readonly string[]).includes(task.status) ||
      (task.leaseToken && (!task.leaseUntil || task.leaseUntil > now))
    ) {
      return null;
    }
    const [pending] = await tx
      .select({ id: codeTaskCommands.id })
      .from(codeTaskCommands)
      .where(
        and(
          eq(codeTaskCommands.taskId, id),
          inArray(codeTaskCommands.status, [...PENDING_COMMAND_STATUSES])
        )
      )
      .limit(1);
    if (pending) {
      return null;
    }
    const orphans = await tx
      .update(codeTaskCommands)
      .set({
        error:
          "Reconciled by workspace cleanup: the task ended without settling it.",
        finishedAt: now,
        leaseToken: null,
        leaseUntil: null,
        status: "settled",
      })
      .where(
        and(
          eq(codeTaskCommands.taskId, id),
          inArray(codeTaskCommands.status, [...ORPHAN_COMMAND_STATUSES])
        )
      )
      .returning({ id: codeTaskCommands.id });
    for (const orphan of orphans) {
      // biome-ignore lint/performance/noAwaitInLoops: event sequence numbers are assigned in order.
      await tx
        .insert(codeTaskEvents)
        .values({
          data: { commandId: orphan.id, reason: "workspace_cleanup" },
          revision: sql`(select revision from code_tasks where id = ${id})`,
          seq: sql`coalesce((select max(seq) from code_task_events where task_id = ${id}), 0) + 1`,
          sourceKey: `command.reconciled:${orphan.id}`,
          taskId: id,
          type: "command.reconciled",
        })
        .onConflictDoNothing();
    }
    const leaseToken = randomUUID();
    const [reserved] = await tx
      .update(codeTasks)
      .set({
        execution: {
          ...task.execution,
          workspaceExpiredAt: now.toISOString(),
        },
        leaseToken,
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        updatedAt: now,
        version: sql`${codeTasks.version} + 1`,
      })
      .where(
        and(
          eq(codeTasks.id, id),
          or(isNull(codeTasks.leaseToken), lt(codeTasks.leaseUntil, now))
        )
      )
      .returning({
        execution: codeTasks.execution,
        id: codeTasks.id,
        leaseToken: codeTasks.leaseToken,
        sessionId: codeTasks.durableSessionId,
      });
    if (!(reserved?.sessionId && reserved.leaseToken)) {
      return null;
    }
    return {
      execution: reserved.execution,
      id: reserved.id,
      leaseToken: reserved.leaseToken,
      sessionId: reserved.sessionId,
    };
  });
}

async function closeWorldRun(
  world: SandboxWorld,
  runId: string
): Promise<void> {
  let run: Awaited<ReturnType<SandboxWorld["runs"]["get"]>> | undefined;
  try {
    run = await world.runs.get(runId, { resolveData: "none" });
  } catch (error) {
    if (error instanceof Error && NOT_FOUND.test(error.message)) {
      return;
    }
    if (
      error &&
      typeof error === "object" &&
      "status" in error &&
      error.status === 404
    ) {
      return;
    }
    throw error;
  }
  if (
    !run ||
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)
  ) {
    return;
  }
  try {
    await world.events.create(runId, {
      eventData: { cancelReason: "code-task workspace retention" },
      eventType: "run_cancelled",
      specVersion: world.specVersion,
    });
  } catch (error) {
    // A lost acknowledgement is safe when the World now reports cancellation.
    const latest = await world.runs.get(runId, { resolveData: "none" });
    if (latest.status !== "cancelled") {
      throw error;
    }
  }
}

async function markCleanupComplete(
  task: CleanupTask,
  now: Date
): Promise<void> {
  await db()
    .update(codeTasks)
    .set({
      execution: executionWithDeletion(task.execution, now),
      leaseToken: null,
      leaseUntil: null,
      updatedAt: now,
      version: sql`${codeTasks.version} + 1`,
    })
    .where(
      and(eq(codeTasks.id, task.id), eq(codeTasks.leaseToken, task.leaseToken))
    );
}

async function releaseCleanupLease(
  id: string,
  leaseToken: string
): Promise<void> {
  await db()
    .update(codeTasks)
    .set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() })
    .where(and(eq(codeTasks.id, id), eq(codeTasks.leaseToken, leaseToken)));
}
