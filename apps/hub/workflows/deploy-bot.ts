import { sleep } from "workflow";
import {
  type DeployRunArg,
  type DeployTarget,
  deployBot,
  deployTargetOf,
  refreshBot,
} from "../lib/bots/service";

/**
 * v2 argument: the bot row and the deploy generation this run builds. A bare slug is the v1
 * argument of runs started before generations existed (a rerun of one): it adopts the row's
 * current generation.
 */
export type DeployBotArg = string | DeployRunArg;

async function resolveTargetStep(
  arg: DeployBotArg
): Promise<DeployTarget | null> {
  "use step";
  const target = await deployTargetOf(arg);
  return target && { botId: target.botId, generation: target.generation };
}

async function startDeployStep(
  target: DeployTarget
): Promise<"adopted" | "failed" | "stale" | "started"> {
  "use step";
  return await deployBot(target);
}

/** "done" once this generation is ready with a session, failed, superseded, deleted or past its deadline. */
async function advanceDeployStep(
  target: DeployTarget
): Promise<"continue" | "done"> {
  "use step";
  try {
    return await refreshBot(target);
  } catch (error) {
    console.warn("deploy refresh failed; checking again", {
      botId: target.botId,
      error: error instanceof Error ? error.message : String(error),
    });
    // An ambiguous answer (Vercel or the database unreachable) is not a failure: check again; the
    // deadline and the reconciler bound it.
    return "continue";
  }
}

// 35 min deadline (DEPLOY_DEADLINE_MS) at one check every 10 s, plus margin; refreshBot decides.
const MAX_CHECKS = 240;

/**
 * Creating or redeploying a bot, durably: build this generation once, wait for READY, promote it
 * under the bot's promotion lease, open its chat session. It stops as soon as the generation
 * moves on or the bot is deleted (the row is gone or `deletionState` is set).
 */
export async function deployBotWorkflow(arg: DeployBotArg) {
  "use workflow";
  const target = await resolveTargetStep(arg);
  if (!target) {
    return;
  }
  const started = await startDeployStep(target);
  if (started === "stale" || started === "failed") {
    return;
  }
  for (let i = 0; i < MAX_CHECKS; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: This durable workflow polls sequentially with a fixed backoff.
    if ((await advanceDeployStep(target)) === "done") {
      return;
    }
    await sleep("10s");
  }
}
