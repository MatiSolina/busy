import { sleep } from "workflow";

async function tick(id: string): Promise<boolean> {
  "use step";
  const { codeTaskTick } = await import("../lib/code-tasks/runtime");
  return codeTaskTick(id);
}

async function followEnded(id: string): Promise<void> {
  "use step";
  const { recordFollowEnded } = await import("../lib/code-tasks/runtime");
  await recordFollowEnded(id);
}

/**
 * Follow only the task projection/outbox; fx owns and recovers the actual
 * agent loop. Running out of ticks is recorded and hands the task to the
 * minute cron's supervision; it never implies the task stopped.
 */
export async function codeTaskWorkflow(id: string) {
  "use workflow";
  for (let attempt = 0; attempt < 540; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: durable polling terminates on the first completed tick.
    if (await tick(id)) {
      return;
    }
    await sleep("5s");
  }
  await followEnded(id);
}
