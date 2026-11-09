import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import {
  codeTaskToolAvailable,
  isCodeTaskCompletion,
} from "../lib/code-task-guards";
import { stableCodeTaskCommandId, updateCodeTask } from "../lib/code-tasks";
import { lazyResult } from "../lib/lazy-tools";

const inputSchema = z
  .object({
    taskId: z.uuid(),
    text: z
      .string()
      .trim()
      .min(1)
      .max(64 * 1024),
  })
  .strict();

export default defineDynamic((ctx) => {
  if (
    !codeTaskToolAvailable(
      ctx.session.auth,
      isConsultation(ctx.session.auth),
      isRoutineExecution(ctx.session.auth)
    )
  ) {
    return null;
  }
  return lazyResult("code", ctx.view, tool);
});

const tool = defineTool({
  availableInSubagents: false,
  description:
    "Send a correction or additional requirement to an existing remote coding task in this same bot chat. Use only when the user clearly refers to a specific task. It steers that task's durable session and does not create a new task. Do not use for a progress question, an unrelated request, changing its repository/provider, or cancelling it.",
  execute(input, ctx) {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Code tasks are unavailable during a read-only consultation."
      );
    }
    if (isRoutineExecution(ctx.session.auth)) {
      throw new Error("Scheduled tasks cannot update remote code work.");
    }
    if (isCodeTaskCompletion(ctx.session.auth)) {
      throw new Error(
        "A code task completion cannot update another code task."
      );
    }
    const parsed = inputSchema.parse(input);
    return updateCodeTask(
      parsed.taskId,
      {
        id: stableCodeTaskCommandId(
          ctx.session.id,
          ctx.callId,
          parsed.taskId,
          "steer"
        ),
        sourceCallId: ctx.callId,
        sourceSessionId: ctx.session.id,
        text: parsed.text,
      },
      undefined,
      ctx.abortSignal
    );
  },
  inputSchema,
  label: { start: () => "Update coding task" },
});
