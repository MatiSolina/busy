import {
  type BindPlanExecutionInput,
  bindPlanExecution,
  observedPlanTasks,
  observePlanExecution,
  type PlanExecutionBudget,
  type PlanMutation,
  planExecutionBudget,
  planState,
  stablePlanDispatchTaskId,
} from "./plan-state";

export interface PlanDispatchReservation {
  budget: PlanExecutionBudget;
  mutation: PlanMutation;
  taskId: string;
}

// biome-ignore lint/suspicious/useAwait: Eve requires durable step functions to be async even when this reservation is synchronous.
export async function reservePlanExecution(
  input: Omit<BindPlanExecutionInput, "taskId"> & {
    callId: string;
    sessionId: string;
  }
): Promise<PlanDispatchReservation> {
  "use step";
  const taskId = stablePlanDispatchTaskId(input.sessionId, input.callId);
  let result = bindPlanExecution(planState.get(), planExecutionBudget.get(), {
    ...input,
    taskId,
  });
  const observed = observedPlanTasks
    .get()
    .find(
      (task) =>
        task.callId === input.callId &&
        task.status === "running" &&
        task.taskId !== taskId
    );
  if (observed) {
    const linked = observePlanExecution(
      result.mutation.plan,
      result.budget,
      {
        callId: observed.callId,
        eventKey: `pre-dispatch:${observed.callId}:${observed.taskId}`,
        kind: observed.kind,
        name: observed.name,
        taskId: observed.taskId,
        type: "task.started",
      },
      input.sessionId
    );
    if (linked.mutation.changed) {
      result = linked;
    }
  }
  if (result.mutation.changed) {
    planState.update(() => result.mutation.plan);
    planExecutionBudget.update(() => result.budget);
  }
  return { ...result, taskId };
}
