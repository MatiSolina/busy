import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { verifyCodeTaskOwnership } from "../lib/code-tasks";
import { lazyResult } from "../lib/lazy-tools";
import {
  bindPlanExecution,
  canManagePlan,
  observedPlanTasks,
  planExecutionBudget,
  planState,
  principalIdOf,
} from "../lib/plan-state";

const inputSchema = z
  .object({
    kind: z.enum(["agent", "peer", "code"]),
    planId: z.string().trim().min(1).max(100),
    revision: z.number().int().positive(),
    stepId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u),
    taskId: z.string().trim().min(1).max(300),
  })
  .strict();

export default defineDynamic((ctx) =>
  canManagePlan(ctx.session) ? lazyResult("plan", ctx.view, tool) : null
);

const tool = defineTool({
  availableInSubagents: false,
  description:
    "Bind an already-started Eve agent/peer task or Busy code task to one root plan step. This is a bounded server-side binding: it validates the task against the current root session, derives owner and execution identity, and never marks business work complete. Call it immediately after the native agent or code task returns its task id, with the plan revision from get.",
  async execute(input, ctx) {
    if (!canManagePlan(ctx.session)) {
      throw new Error("Only the user-facing root session can bind plan work.");
    }
    const parsed = inputSchema.parse(input);
    if (parsed.kind === "code" && !z.uuid().safeParse(parsed.taskId).success) {
      throw new Error("A code binding requires the code task's UUID.");
    }
    if (
      parsed.kind === "code" &&
      !(await verifyCodeTaskOwnership(
        parsed.taskId,
        ctx.session.id,
        undefined,
        ctx.abortSignal
      ))
    ) {
      throw new Error(
        "That code task is not owned by this root session or could not be verified."
      );
    }
    const observation =
      parsed.kind === "code"
        ? undefined
        : observedPlanTasks
            .get()
            .find((candidate) => candidate.taskId === parsed.taskId);
    if (parsed.kind !== "code" && !observation) {
      throw new Error("That task is not owned by this root session.");
    }
    const current = planState.get();
    const result = bindPlanExecution(
      current,
      planExecutionBudget.get(),
      {
        kind: parsed.kind,
        owner: {
          callId: observation?.callId ?? ctx.callId,
          principalId: principalIdOf(ctx.session),
          sessionId: ctx.session.id,
          turnId: ctx.session.turn.id,
        },
        planId: parsed.planId,
        revision: parsed.revision,
        stepId: parsed.stepId,
        taskId: parsed.taskId,
      },
      observation
        ? {
            callId: observation.callId,
            kind: observation.kind,
            name: observation.name,
            status: observation.status,
            taskId: observation.taskId,
            turnId: observation.turnId,
          }
        : undefined
    );
    if (result.mutation.changed) {
      planState.update(() => result.mutation.plan);
      planExecutionBudget.update(() => result.budget);
    }
    return {
      executionId: result.mutation.execution?.id,
      plan: result.mutation.plan,
      status: result.mutation.execution?.status ?? "bound",
    };
  },
  inputSchema,
  label: { start: () => "Bind plan execution" },
});
