import { createHash } from "node:crypto";

const FX_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

export function fxMessageId(value: string): string {
  if (FX_MESSAGE_ID_PATTERN.test(value)) {
    return value;
  }
  const digest = createHash("sha256")
    .update("busy:fx-message-id")
    .update(value)
    .digest("hex")
    .slice(0, 48);
  return `legacy-${digest}`;
}

export function generatedFxMessageId(taskId: string, suffix: string): string {
  return `code-task-${taskId}-${suffix}`;
}
