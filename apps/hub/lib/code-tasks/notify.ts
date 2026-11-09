import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { syncBot } from "../chat/store";
import { bots, type CodeTaskRow, codeTasks, db } from "../db";
import { sendMessage } from "../eve/client";
import { signCodeTaskToken } from "../hub-token";
import { appendEvent, getTaskRow, patchRuntimeExecution } from "./store";

const NOTIFIABLE_STATUSES = [
  "ready",
  "failed",
  "cancelled",
  "needs_attention",
  "waiting_for_input",
];

/**
 * Outbox identity of a result: revision, instruction version and status.
 * `waiting_for_input` and a later `cancelled` are distinct results even when
 * the revision and instruction are the same.
 */
export function notificationKey(
  task: Pick<CodeTaskRow, "instructionVersion" | "revision" | "status">
): string {
  return `${task.revision}:${task.instructionVersion}:${task.status}`;
}

export function notificationId(
  task: Pick<CodeTaskRow, "id" | "instructionVersion" | "revision" | "status">
) {
  const bytes = createHash("sha256")
    .update(
      `busy-code-result:${task.id}:${task.revision}:${task.instructionVersion}:${task.status}`
    )
    .digest();
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function recordedKey(task: CodeTaskRow): string | null {
  const { notification } = task.execution;
  if (
    notification &&
    typeof notification === "object" &&
    !Array.isArray(notification)
  ) {
    const { key } = notification as Record<string, unknown>;
    return typeof key === "string" ? key : null;
  }
  return null;
}

/** Whether the task still owes a notification for its current status. */
export function notificationOwed(task: CodeTaskRow): boolean {
  if (!NOTIFIABLE_STATUSES.includes(task.status)) {
    return false;
  }
  const key = recordedKey(task);
  if (key !== null) {
    return key !== notificationKey(task);
  }
  // Rows notified before the status-aware outbox: the legacy marker covers
  // its instruction version, so deploying this does not resend history.
  const legacy = task.execution.notificationInstructionVersion;
  return !(typeof legacy === "number" && legacy >= task.instructionVersion);
}

/** Record the tuple that was actually handled, only if the task still has that tuple. */
function recordOutcome(
  task: CodeTaskRow,
  outcome: "sent" | "skipped",
  extra: Record<string, unknown>
) {
  return patchRuntimeExecution(
    task.id,
    {
      notification: {
        at: Date.now(),
        key: notificationKey(task),
        outcome,
        ...extra,
      },
      // Keep the legacy markers coherent for older readers.
      notificationInstructionVersion: task.instructionVersion,
      notificationSkipped: outcome === "skipped",
      ...(outcome === "sent" ? { notificationMessageId: extra.messageId } : {}),
    },
    {
      where: and(
        eq(codeTasks.revision, task.revision),
        eq(codeTasks.instructionVersion, task.instructionVersion),
        eq(codeTasks.status, task.status)
      ),
    }
  );
}

/** Notification retries pin session and message identity. Failure to notify never changes the code result. */
export async function notifyCodeResult(id: string): Promise<void> {
  const task = await getTaskRow(id);
  if (!(task && notificationOwed(task))) {
    return;
  }
  if (!task.botId) {
    // The originating bot was deleted: there is no conversation to inform.
    await markNotificationSkipped(task, "bot_deleted");
    return;
  }
  const [bot] = await db()
    .select()
    .from(bots)
    .where(eq(bots.id, task.botId))
    .limit(1);
  // Do not use sendToBot: its recovery may create a replacement conversation.
  if (!bot || bot.sessionId !== task.sourceSessionId || !bot.url) {
    await markNotificationSkipped(
      task,
      bot ? "source session unavailable" : "bot_deleted"
    );
    return;
  }
  const messageId = notificationId(task);
  const text = `<code_task_result>\nTask: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}\nRepository: ${task.repositoryFullName}\nPR: ${task.pullRequestUrl ?? "none"}\nSummary: ${task.summary ?? task.error ?? "Open the task card for details."}\n</code_task_result>\nThis is a service notification about existing work. Give the user a brief update with the result link or next action. Do not create another code task or answer any pending human-input request.`;
  const call = {
    token: () => signCodeTaskToken(bot.slug, task.id),
    url: bot.url,
  };
  // The id is stable per (task, revision, instruction, status): a retry is
  // deduplicated by the bot session.
  await sendMessage(call, task.sourceSessionId, {
    files: [],
    id: messageId,
    text,
    turnPolicy: "queue",
  });
  // If the status changed while sending, nothing is recorded for the new
  // status: it stays owed and is evaluated on the next cycle.
  const recorded = await recordOutcome(task, "sent", { messageId });
  if (!recorded) {
    return;
  }
  await appendEvent(
    id,
    "notification.sent",
    {
      message: "Result delivered to the main conversation.",
      status: task.status,
    },
    { sourceKey: `notification:${messageId}` }
  );
  await syncBot(bot).catch(() => undefined);
}

async function markNotificationSkipped(
  task: CodeTaskRow,
  reason: string
): Promise<void> {
  const recorded = await recordOutcome(task, "skipped", { reason });
  if (!recorded) {
    return;
  }
  await appendEvent(
    task.id,
    "notification.skipped",
    { reason, status: task.status },
    {
      sourceKey: `notification-skipped:${notificationKey(task)}`,
    }
  );
}
