import { start } from "workflow/api";
import { firesideWorkflow } from "../../workflows/fireside";
import { db } from "../db";
import {
  claimRunnerStart,
  recordRunnerStart,
  releaseRunnerStart,
  wakeRunner,
} from "./runner";

/**
 * Starts the workflow of a runner that was acquired but not started yet. Concurrent callers race on
 * `claimRunnerStart`; exactly one calls `start()`. A crash after the claim leaves an active runner
 * without heartbeats, which a later wake takes over once its lease expires.
 */
export async function startPendingRunner(id: string) {
  const runId = await claimRunnerStart(id);
  if (!runId) {
    return false;
  }
  try {
    const run = await start(firesideWorkflow, [id, runId]);
    await recordRunnerStart(id, runId, run.runId);
  } catch (error) {
    await releaseRunnerStart(
      id,
      runId,
      error instanceof Error ? error.message.slice(0, 500) : "start_failed"
    );
    throw error;
  }
  return true;
}

/**
 * Idempotent: makes sure the fireside has one live runner and that it sees new work. Routes and the
 * cron may call it any number of times; it never starts a second workflow while one is alive.
 */
export async function scheduleFireside(id: string) {
  await wakeRunner(db(), id);
  return startPendingRunner(id);
}
