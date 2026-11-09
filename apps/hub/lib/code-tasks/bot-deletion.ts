import { and, eq, inArray } from "drizzle-orm";
import { bots, codeTaskBotShutdowns, codeTasks, db } from "@/lib/db";
import { enqueueCommand } from "./store";
import { CodeTaskConflictError } from "./types";

/** Statuses that may still execute, publish or hold a slot. */
const UNSETTLED_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "cancel_requested",
] as const;

/**
 * First step of deleting a bot (H-25). Idempotent; call it until `pending`
 * is 0 before removing the bot row.
 *
 * 1. Records a shutdown marker under the bot row lock, so `createTask` and
 *    every non-cancel `enqueueCommand` for the bot are rejected from now on.
 * 2. Requests cancellation of each unsettled task through the normal CAS
 *    command path with a deterministic message id (retries add nothing).
 *    The dispatcher stops the durable session and only a confirmed stop, or
 *    the watchdog's fence, makes a task `cancelled`; a timeout alone never
 *    does.
 * 3. Returns how many tasks have not reached a terminal state yet.
 *
 * `ready` and `needs_attention` tasks are not cancelled: their result and any
 * published draft PR are preserved, and the marker already blocks new work.
 * After the bot row is deleted, tasks keep their history with
 * `bot_id = NULL`, which the store treats as "no new instructions".
 */
export async function requestBotCodeTaskShutdown(
  botId: string
): Promise<{ pending: number }> {
  await db().transaction(async (tx) => {
    const [bot] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.id, botId))
      .for("update");
    if (bot) {
      await tx
        .insert(codeTaskBotShutdowns)
        .values({ botId })
        .onConflictDoNothing();
    }
  });
  const unsettled = await db()
    .select({ id: codeTasks.id, status: codeTasks.status })
    .from(codeTasks)
    .where(
      and(
        eq(codeTasks.botId, botId),
        inArray(codeTasks.status, [...UNSETTLED_STATUSES])
      )
    );
  for (const task of unsettled) {
    if (task.status === "cancel_requested") {
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each cancellation is its own CAS transaction.
      await enqueueCommand(task.id, {
        kind: "cancel",
        messageId: `bot-delete-${task.id}`,
      });
    } catch (error) {
      // A publication lease or a concurrent transition: the task stays
      // pending and the next call retries.
      if (!(error instanceof CodeTaskConflictError)) {
        throw error;
      }
    }
  }
  const remaining = await db()
    .select({ id: codeTasks.id })
    .from(codeTasks)
    .where(
      and(
        eq(codeTasks.botId, botId),
        inArray(codeTasks.status, [...UNSETTLED_STATUSES])
      )
    );
  return { pending: remaining.length };
}
