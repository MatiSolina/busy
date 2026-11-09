import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import {
  codeTaskToolAvailable,
  isCodeTaskCompletion,
} from "../lib/code-task-guards";
import { cancelCodeTask, stableCodeTaskCommandId } from "../lib/code-tasks";
import { lazyResult } from "../lib/lazy-tools";

const inputSchema = z.object({ taskId: z.uuid() }).strict();

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
    "Request cancellation of an existing remote coding task. Use only when the user explicitly asks to stop a specific task. Cancellation is asynchronous; report the returned status and do not claim that running commands stopped until the task confirms it.",
  execute(input, ctx) {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Code tasks are unavailable during a read-only consultation."
      );
    }
    if (isRoutineExecution(ctx.session.auth)) {
      throw new Error("Scheduled tasks cannot cancel remote code work.");
    }
    if (isCodeTaskCompletion(ctx.session.auth)) {
      throw new Error(
        "A code task completion cannot cancel another code task."
      );
    }
    const parsed = inputSchema.parse(input);
    return cancelCodeTask(
      parsed.taskId,
      {
        id: stableCodeTaskCommandId(
          ctx.session.id,
          ctx.callId,
          parsed.taskId,
          "cancel"
        ),
        sourceCallId: ctx.callId,
        sourceSessionId: ctx.session.id,
      },
      undefined,
      ctx.abortSignal
    );
  },
  inputSchema,
  label: { start: () => "Cancel coding task" },
});
