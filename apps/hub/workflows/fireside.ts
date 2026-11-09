import { sleep } from "workflow";
import { start } from "workflow/api";

/** Ticks before the run hands over to a fresh run with the same `runId`, bounding its event log. */
const TICKS_PER_RUN = 300;

async function runnerStep(id: string, runId: string): Promise<number | null> {
  "use step";
  const { runFiresideRunner } = await import("../lib/firesides/runtime");
  return runFiresideRunner(id, runId);
}

async function adoptLegacyRun(id: string) {
  "use step";
  const { scheduleFireside } = await import("../lib/firesides/schedule");
  await scheduleFireside(id);
}

/**
 * The durable runner of one fireside (H-32). `runId` is the runner row's id: every tick first
 * proves it still owns the row, so a replaced runner stops instead of polling alongside the new one.
 */
export async function firesideWorkflow(id: string, runId?: string) {
  "use workflow";
  if (!runId) {
    // Queued with the pre-runner signature: route it through the runner instead of polling.
    await adoptLegacyRun(id);
    return;
  }
  for (let tick = 0; tick < TICKS_PER_RUN; tick += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: durable polling follows one sequential conversation.
    const waitMs = await runnerStep(id, runId);
    if (waitMs === null) {
      return;
    }
    await sleep(`${Math.max(1, Math.ceil(waitMs / 1000))}s`);
  }
  // Still owned and still busy: continue in a new run. The runner row (and its lease) is unchanged;
  // reaching a polling limit never releases the runner.
  await start(firesideWorkflow, [id, runId]);
}
