import { sleep } from "workflow";
import {
  botRowGone,
  collectAfterDeletion,
  type DeletionStage,
  defaultDeletionDeps,
  finalizeBotDeletion,
  recordBotDeletionFailure,
  runDeletionStage,
} from "../lib/bots/deletion";
import { deleteBotBlobs } from "../lib/files";

// Same order as DELETION_STAGES in lib/bots/deletion.ts; repeated here because the workflow body
// cannot import that module's runtime values (it pulls the database driver).
const STAGES: readonly DeletionStage[] = [
  "code-tasks",
  "project",
  "schedules",
  "blobs",
];

async function deletionStep(
  botId: string,
  token: string,
  stage: DeletionStage
): Promise<{ slug: string } | null> {
  "use step";
  return await runDeletionStage(botId, token, stage, defaultDeletionDeps());
}

async function finalizeStep(botId: string, token: string): Promise<boolean> {
  "use step";
  return await finalizeBotDeletion(botId, token);
}

async function collectStep(): Promise<number> {
  "use step";
  return await collectAfterDeletion();
}

async function recordFailureStep(
  botId: string,
  token: string,
  message: string
): Promise<void> {
  "use step";
  await recordBotDeletionFailure(botId, token, message);
}

async function lateSweepStep(botId: string, slug: string): Promise<void> {
  "use step";
  if (await botRowGone(botId)) {
    await deleteBotBlobs({ id: botId, slug });
  }
}

/**
 * Deletes a bot marked `deleting` (lib/bots/deletion.ts). Started by DELETE /api/bots/[slug] and
 * restarted by the library verification cron for a deletion whose run failed or never started. Every
 * step is idempotent and fenced by the deletion token, so a restarted or duplicate run is safe.
 */
export async function deleteBotWorkflow(botId: string, token: string) {
  "use workflow";
  let slug: string | null = null;
  try {
    for (const stage of STAGES) {
      // biome-ignore lint/performance/noAwaitInLoops: The deletion's effects run in order.
      const step = await deletionStep(botId, token, stage);
      if (!step) {
        return;
      }
      ({ slug } = step);
    }
    if (!(await finalizeStep(botId, token))) {
      return;
    }
  } catch (error) {
    await recordFailureStep(
      botId,
      token,
      error instanceof Error ? error.message : "deletion failed"
    );
    return;
  }
  // The general sweep in the library verification cron also collects these, so a failure here is not
  // a failed deletion.
  await collectStep().catch(() => 0);
  if (slug) {
    // An upload URL signed just before the mark can still land for 15 minutes; sweep once more after.
    await sleep("30m");
    await lateSweepStep(botId, slug);
  }
}
