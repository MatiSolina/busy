import { createHash } from "node:crypto";
import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { lazyResult } from "../lib/lazy-tools";
import { canManagePlan, planState, resetPlanBudget } from "../lib/plan-state";
import { planStatus, planStepProblems } from "../lib/task-plan";
import { planStepsSchema } from "../lib/task-plan-schema";

const title = z.string().trim().min(1).max(200);
const id = z.string().min(1).max(100);
const revision = z.number().int().positive();
const actions = {
  cancel: z
    .object({
      action: z.literal("cancel"),
      id,
      reason: z.string().trim().min(1).max(2000),
      revision,
    })
    .strict(),
  create: z
    .object({ action: z.literal("create"), steps: planStepsSchema, title })
    .strict(),
  get: z.object({ action: z.literal("get") }).strict(),
  update: z
    .object({
      action: z.literal("update"),
      id,
      revision,
      steps: planStepsSchema,
      title: title.optional(),
    })
    .strict(),
};

// An object root works across the subscription providers too. Validate each
// action at runtime instead of sending a root-level union to the provider.
const inputSchema = z
  .object({
    action: z.enum(["get", "create", "update", "cancel"]),
    id: id.optional(),
    reason: z.string().trim().min(1).max(2000).optional(),
    revision: revision.optional(),
    steps: planStepsSchema.optional(),
    title: title.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const parsed = actions[input.action].safeParse(input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: "custom",
          message: issue.message,
          path: issue.path,
        });
      }
    }
  });

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Keep execution identity server-owned; the model may only edit business fields. */
function mergeExecutionState(
  current: NonNullable<ReturnType<typeof planState.get>>,
  incoming: z.infer<typeof planStepsSchema>
) {
  const currentById = new Map(current.steps.map((step) => [step.id, step]));
  return incoming.map((step) => {
    const previous = currentById.get(step.id);
    if (!previous?.execution) {
      if (step.execution) {
        throw new Error("Execution bindings are created by the server helper.");
      }
      return step;
    }
    if (step.execution && !sameJson(step.execution, previous.execution)) {
      throw new Error("Execution bindings are server-owned.");
    }
    if (step.taskId !== undefined && step.taskId !== previous.taskId) {
      throw new Error("A bound step cannot change its task id.");
    }
    if (
      !step.execution &&
      (previous.execution.status === "bound" ||
        previous.execution.status === "running")
    ) {
      return {
        ...step,
        execution: previous.execution,
        taskId: previous.taskId,
      };
    }
    // A root update may clear a terminal binding to retry, subject to the
    // total dispatch budget enforced by bind_plan_execution.
    if (!step.execution && step.status === "pending") {
      return step;
    }
    return { ...step, execution: previous.execution, taskId: previous.taskId };
  });
}

export default defineDynamic((ctx) =>
  canManagePlan(ctx.session) ? lazyResult("plan", ctx.view, tool) : null
);

const tool = defineTool({
  availableInSubagents: false,
  description:
    "Track complex work with a durable plan in this conversation. Use proactively for dependent steps, substantial work or coordination across agents; skip simple requests. Create a focused plan, continue the authorized work immediately, and update it as evidence arrives. Each step has a stable id, title, expectedResult, assignee (self or an available agent/bot), dependsOn ids and status. After the existing agent, peer or code tool returns a task id, call bind_plan_execution so the server can observe it; never invent task ids or execution outcomes. Completed delegated steps require a settled result plus a note with the verified business evidence; blocked and failed steps require the blocker or failure. Get the current plan to resume or resolve a revision conflict. Update sends all steps, retaining their ids and progress. Planning records assignments; it never starts tasks, grants permissions, approves external actions or cancels running agents. Cancel running tasks with their existing controls before cancelling the plan. Keep authorization and consultation limits unchanged.",
  execute(input, ctx) {
    if (!canManagePlan(ctx.session)) {
      throw new Error("Only the user-facing root session can manage its plan.");
    }
    const parsed = inputSchema.parse(input);
    if (parsed.action === "get") {
      return { plan: planState.get() };
    }
    if (parsed.action === "create") {
      const details = actions.create.parse(parsed);
      if (details.steps.some((step) => step.execution)) {
        throw new Error("Execution bindings are created by the server helper.");
      }
      const planId = `plan-${createHash("sha256")
        .update(JSON.stringify([ctx.session.id, ctx.callId]))
        .digest("hex")
        .slice(0, 32)}`;
      const existing = planState.get();
      if (existing?.id === planId) {
        return { plan: existing };
      }
      planState.update((current) => {
        if (current && planStatus(current) === "active") {
          throw new Error(
            "An active plan already exists. Get and update it, or finish/cancel it before creating another."
          );
        }
        return {
          dispatchCount: 0,
          id: planId,
          revision: 1,
          steps: details.steps,
          title: details.title,
        };
      });
      resetPlanBudget(planId);
      return { plan: planState.get() };
    }
    planState.update((current) => {
      if (!current || current.id !== parsed.id) {
        throw new Error(
          "Plan not found in this session. Get the current plan."
        );
      }
      if (current.revision !== parsed.revision) {
        throw new Error("Plan revision changed. Get it before updating again.");
      }
      if (parsed.action === "cancel") {
        const { reason } = actions.cancel.parse(parsed);
        return {
          ...current,
          revision: current.revision + 1,
          steps: current.steps.map((step) =>
            step.status === "completed" || step.status === "cancelled"
              ? step
              : { ...step, note: reason, status: "cancelled" as const }
          ),
        };
      }
      const details = actions.update.parse(parsed);
      const steps = mergeExecutionState(current, details.steps);
      const problems = planStepProblems(steps);
      if (problems.length > 0) {
        throw new Error(problems[0]);
      }
      return {
        ...current,
        revision: current.revision + 1,
        steps,
        title: details.title ?? current.title,
      };
    });
    if (parsed.action === "cancel") {
      resetPlanBudget(null);
    }
    return { plan: planState.get() };
  },
  inputSchema,
  label: { start: ({ action }) => `${action} plan` },
});
