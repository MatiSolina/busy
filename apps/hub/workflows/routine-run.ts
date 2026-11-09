import { sleep } from "workflow";
import { refreshRoutineRun } from "../lib/routines/monitor";

// The step still returns a boolean: workflows already in flight replay their recorded results.
async function refreshStep(runId: string): Promise<boolean> {
  "use step";
  return await refreshRoutineRun(runId);
}

/** Follow one routine occurrence without depending on the app being open. */
export async function routineRunWorkflow(runId: string) {
  "use workflow";
  // Same two-hour bound as ordinary turns. Ending here does not end the turn: a run still
  // `dispatched` after that stays in its row, and the `/api/cron/routines` sweep keeps observing it
  // through its pinned session until a terminal fact or evidence that the session is gone.
  for (let i = 0; i < 480; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: This durable workflow polls sequentially with a fixed backoff.
    if (await refreshStep(runId)) {
      return;
    }
    await sleep("15s");
  }
}
