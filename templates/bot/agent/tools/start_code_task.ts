import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import {
  codeTaskToolAvailable,
  isCodeTaskCompletion,
} from "../lib/code-task-guards";
import { stableCodeTaskId, startCodeTask } from "../lib/code-tasks";
import { lazyResult } from "../lib/lazy-tools";

const inputSchema = z
  .object({
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(2000))
      .max(20)
      .optional(),
    goal: z.string().trim().min(1).max(20_000),
    repositoryId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200),
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
    "Start a remote coding task in the verified Busy repository returned by prepare_code_repository. Use only when the user explicitly asks you to implement or change repository code. The task runs independently in a durable remote coding session and returns immediately with a task id. Do not use for explanations, code suggestions, routine executions, consultations, completion notifications, or unrelated work. Never invent a repository id or clone URL.",
  execute(input, ctx) {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Code tasks are unavailable during a read-only consultation."
      );
    }
    if (isRoutineExecution(ctx.session.auth)) {
      throw new Error("Scheduled tasks cannot start remote code work.");
    }
    if (isCodeTaskCompletion(ctx.session.auth)) {
      throw new Error("A code task completion cannot start another code task.");
    }
    const parsed = inputSchema.parse(input);
    const id = stableCodeTaskId(ctx.session.id, ctx.callId);
    return startCodeTask(
      {
        ...parsed,
        id,
        sourceCallId: ctx.callId,
        sourceSessionId: ctx.session.id,
      },
      undefined,
      ctx.abortSignal
    );
  },
  inputSchema,
  label: { start: ({ title }) => `Start coding: ${title}` },
});
