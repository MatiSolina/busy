import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import { isCodeTaskCompletion } from "../lib/code-task-guards";
import { deferredAtCore } from "../lib/lazy-tools";
import { reservePlanExecution } from "../lib/plan-dispatch-step";

const targetName = z.string().regex(/^(?:agent|peer-(?:[1-9]|1[0-2]))$/u);
const inputSchema = z
  .object({
    message: z.string().trim().min(1).max(20_000),
    planId: z.string().trim().min(1).max(100).optional(),
    revision: z.number().int().positive().optional(),
    stepId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/u)
      .optional(),
    target: targetName.optional(),
  })
  .strict();

function rootOnly(ctx: {
  session: {
    auth: Parameters<typeof isConsultation>[0];
    parent?: unknown;
  };
}): void {
  if (
    ctx.session.parent ||
    isConsultation(ctx.session.auth) ||
    isRoutineExecution(ctx.session.auth) ||
    isCodeTaskCompletion(ctx.session.auth)
  ) {
    throw new Error(
      "Only the user-facing root session can dispatch plan work."
    );
  }
}

function principalId(ctx: { session: { auth: unknown } }): string | undefined {
  const current = (
    ctx.session.auth as {
      current?: { principalId?: unknown } | null;
    } | null
  )?.current;
  return typeof current?.principalId === "string"
    ? current.principalId
    : undefined;
}

export default defineWorkflowTool({
  availableInSubagents: false,
  deferred: deferredAtCore("dispatch_plan_step"),
  description:
    "Start one bounded delegated plan step through Eve's existing agent or peer session. The server reserves the root plan budget before opening the child, binds the owner/session/revision, and observes the child settlement. The returned Eve taskId can receive follow-up messages or cancellation through native task controls. Use bind_plan_execution only when a native agent or code task was already started.",
  inputSchema,
  label: {
    start: ({ target: selectedTarget }) =>
      `Delegate plan step to ${selectedTarget ?? "agent"}`,
  },
  async serve(receive, ctx) {
    "use workflow";
    const first = await receive();
    rootOnly(ctx);
    const firstInput = inputSchema.parse(first.input);
    if (
      !firstInput.planId ||
      firstInput.revision === undefined ||
      !firstInput.stepId ||
      !firstInput.target
    ) {
      throw new Error(
        "The first dispatch call requires planId, revision, stepId and target."
      );
    }
    const { target } = firstInput;
    const child = ctx.agent(target);
    const reservation = await reservePlanExecution({
      callId: first.callId,
      kind: target === "agent" ? "agent" : "peer",
      owner: {
        callId: first.callId,
        principalId: principalId(ctx),
        sessionId: ctx.session.id,
        turnId: ctx.session.turn.id,
      },
      planId: firstInput.planId,
      preDispatch: true,
      revision: firstInput.revision,
      sessionId: ctx.session.id,
      stepId: firstInput.stepId,
    });

    let currentCall = first;
    let currentInput = firstInput;
    for (;;) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: A serve task must forward each correction to the same child in order.
        const response = await child.send(currentInput.message, {
          signal: currentCall.abortSignal,
        });
        const settled = await response.result();
        if (settled.status !== "completed") {
          throw new Error(
            settled.status === "failed"
              ? settled.error.message
              : "Delegated task was cancelled."
          );
        }
        ctx.reply({
          executionId: reservation.mutation.execution?.id,
          plan: reservation.mutation.plan,
          result: settled.data ?? settled.reply,
        });
      } catch (error) {
        if (!currentCall.abortSignal.aborted) {
          throw error;
        }
      }

      currentCall = await receive();
      rootOnly(ctx);
      currentInput = inputSchema.parse(currentCall.input);
    }
  },
});
