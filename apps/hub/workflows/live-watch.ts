import { sleep } from "workflow";
import { stopIfUnwatched } from "../lib/live";

async function checkStep(slug: string): Promise<boolean> {
  "use step";
  return await stopIfUnwatched(slug);
}

/**
 * Started when the hub keeps a bot's computer on (its chat opened, a message, a viewer): once that time
 * is up and the bot is idle, stops the computer.
 */
export async function liveWatchWorkflow(slug: string) {
  "use workflow";
  // ponytail: checks every minute for up to 3 h; the sandbox's own 45-minute timeout ends anything longer.
  for (let i = 0; i < 180; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: This durable workflow polls sequentially with a fixed backoff.
    if (await checkStep(slug)) {
      return;
    }
    await sleep("1m");
  }
}
