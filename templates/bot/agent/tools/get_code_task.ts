import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import {
  codeTaskToolAvailable,
  isCodeTaskCompletion,
} from "../lib/code-task-guards";
import { getCodeTask, listCodeTasks } from "../lib/code-tasks";
import { lazyResult } from "../lib/lazy-tools";

const inputSchema = z.object({ taskId: z.uuid().optional() }).strict();

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
    "Read the current status of a remote coding task, or list this bot's recent tasks when taskId is omitted. Use this to answer progress questions; it never changes the coding session. Do not steer the task with this tool.",
  execute(input, ctx) {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Code tasks are unavailable during a read-only consultation."
      );
    }
    if (isRoutineExecution(ctx.session.auth)) {
      throw new Error("Scheduled tasks cannot read remote code work.");
    }
    if (isCodeTaskCompletion(ctx.session.auth)) {
      throw new Error(
        "A code task completion cannot read or create another code task."
      );
    }
    const parsed = inputSchema.parse(input);
    return parsed.taskId
      ? getCodeTask(parsed.taskId, undefined, ctx.abortSignal)
      : listCodeTasks(undefined, ctx.abortSignal);
  },
  inputSchema,
  label: { start: () => "Read coding task" },
});
