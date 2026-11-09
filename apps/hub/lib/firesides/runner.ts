import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, firesideRunners } from "../db";

/**
 * The single durable runner of a fireside (H-32, drizzle/0034). Commands, answers, creation and the
 * cron call `wakeRunner`; only a call that finds the runner idle or its lease expired acquires it
 * (new `run_id`, `generation + 1`, `starting`). Exactly one caller then wins `claimRunnerStart` and
 * starts the workflow. The workflow heartbeats with its `run_id`; once another acquisition replaces
 * it, its heartbeat fails and it stops without mutating anything.
 */
const LEASE = sql`now() + interval '5 minutes'`;

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type Queryable = ReturnType<typeof db> | Tx;

const r = firesideRunners;
const takeover = sql`(${r.status} = 'idle' or ${r.leaseUntil} is null or ${r.leaseUntil} < now())`;
const whenTakeover = (then: ReturnType<typeof sql>, otherwise: unknown) =>
  sql`case when ${takeover} then ${then} else ${otherwise} end`;

/**
 * Wakes the fireside's runner. Every call counts a wake, so a runner deciding to go idle sees the
 * new work; it acquires the runner only when none is alive. Call it inside the transaction that
 * makes new work visible, so the wake and the work commit together.
 */
export async function wakeRunner(q: Queryable, firesideId: string) {
  const [row] = await q
    .insert(r)
    .values({
      attempts: 1,
      firesideId,
      generation: 1,
      leaseUntil: LEASE,
      runId: randomUUID(),
      status: "starting",
      wakes: 1,
    })
    .onConflictDoUpdate({
      set: {
        attempts: whenTakeover(sql`${r.attempts} + 1`, r.attempts),
        generation: whenTakeover(sql`${r.generation} + 1`, r.generation),
        heartbeatAt: whenTakeover(sql`null`, r.heartbeatAt),
        leaseUntil: whenTakeover(sql`excluded.lease_until`, r.leaseUntil),
        runId: whenTakeover(sql`excluded.run_id`, r.runId),
        status: whenTakeover(sql`'starting'`, r.status),
        updatedAt: sql`now()`,
        wakes: sql`${r.wakes} + 1`,
        workflowRunId: whenTakeover(sql`null`, r.workflowRunId),
      },
      target: r.firesideId,
    })
    .returning({
      generation: r.generation,
      runId: r.runId,
      status: r.status,
    });
  return row;
}

/** One caller turns an acquired runner into a started one; the others leave it alone. */
export async function claimRunnerStart(firesideId: string) {
  const [row] = await db()
    .update(r)
    .set({
      heartbeatAt: sql`now()`,
      leaseUntil: LEASE,
      status: "active",
      updatedAt: sql`now()`,
    })
    .where(and(eq(r.firesideId, firesideId), eq(r.status, "starting")))
    .returning({ runId: r.runId });
  return row?.runId ?? null;
}

export async function recordRunnerStart(
  firesideId: string,
  runId: string,
  workflowRunId: string
) {
  await db()
    .update(r)
    .set({ lastError: null, workflowRunId })
    .where(and(eq(r.firesideId, firesideId), eq(r.runId, runId)));
}

/** `start()` failed: hand the start back so the next wake or the cron retries it. */
export async function releaseRunnerStart(
  firesideId: string,
  runId: string,
  error: string
) {
  await db()
    .update(r)
    .set({ lastError: error, status: "starting", updatedAt: sql`now()` })
    .where(
      and(
        eq(r.firesideId, firesideId),
        eq(r.runId, runId),
        eq(r.status, "active")
      )
    );
}

/** The workflow's proof of ownership before each tick. `null`: another runner owns the fireside. */
export async function heartbeatRunner(firesideId: string, runId: string) {
  const [row] = await db()
    .update(r)
    .set({ heartbeatAt: sql`now()`, leaseUntil: LEASE, updatedAt: sql`now()` })
    .where(
      and(
        eq(r.firesideId, firesideId),
        eq(r.runId, runId),
        eq(r.status, "active")
      )
    )
    .returning({ wakes: r.wakes });
  return row ?? null;
}

/**
 * Nothing left to do: go idle, unless a wake arrived since the heartbeat (then keep running).
 * Returns whether the runner is now idle.
 */
export async function idleRunner(
  firesideId: string,
  runId: string,
  wakes: number
) {
  const [row] = await db()
    .update(r)
    .set({ leaseUntil: null, status: "idle", updatedAt: sql`now()` })
    .where(
      and(
        eq(r.firesideId, firesideId),
        eq(r.runId, runId),
        eq(r.status, "active"),
        eq(r.wakes, wakes)
      )
    )
    .returning({ runId: r.runId });
  return Boolean(row);
}
