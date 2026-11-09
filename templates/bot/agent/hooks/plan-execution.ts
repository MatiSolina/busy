import { defineHook } from "eve/hooks";
import { isConsultation, isRoutineExecution } from "../lib/caller";
import { isCodeTaskCompletion } from "../lib/code-task-guards";
import { getCodeTask } from "../lib/code-tasks";
import { restorePlanFromHub } from "../lib/plan-recovery-runtime";
import {
  observePlanExecution,
  planExecutionBudget,
  planRecoveryCheck,
  planState,
  recordObservedTaskEnd,
  recordObservedTaskStart,
  resetPlanBudget,
} from "../lib/plan-state";
import type { PlanExecution } from "../lib/task-plan";

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function eventKey(ctx: { position: { line: number; index: number } }): string {
  return `${ctx.position.line}:${ctx.position.index}`;
}

function apply(
  current: ReturnType<typeof planState.get>,
  ctx: {
    occurrence: { abortSignal: AbortSignal };
    session: {
      auth: Parameters<typeof isCodeTaskCompletion>[0];
      id: string;
      parent?: unknown;
    };
    position: { line: number; index: number };
  },
  event: Parameters<typeof observePlanExecution>[2]
) {
  if (!current || ctx.session.parent) {
    return;
  }
  const result = observePlanExecution(
    current,
    planExecutionBudget.get(),
    event,
    ctx.session.id
  );
  if (!result.mutation.changed) {
    return;
  }
  planState.update(() => result.mutation.plan);
  planExecutionBudget.update(() => result.budget);
}

type PlanExecutionContext = Parameters<typeof apply>[1];
type PlanExecutionEvent = Parameters<typeof observePlanExecution>[2];

interface ActiveCodeExecution extends PlanExecution {
  taskId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isActiveCodeExecution(
  execution: PlanExecution | undefined
): execution is ActiveCodeExecution {
  if (execution?.kind !== "code" || !execution.taskId) {
    return false;
  }
  return execution.status === "bound" || execution.status === "running";
}

function codeTaskStatus(task: unknown): string | undefined {
  if (!isRecord(task) || typeof task.status !== "string") {
    return undefined;
  }
  return task.status;
}

function codeTaskEvent(
  ctx: PlanExecutionContext,
  taskId: string,
  status: string
): PlanExecutionEvent | undefined {
  const codeEventKey = `${ctx.position.line}:${ctx.position.index}:code:${taskId}`;
  switch (status) {
    case "ready":
      return {
        eventKey: codeEventKey,
        outcome: "completed",
        output: { source: "authenticated-code-task", status },
        taskId,
        type: "task.ended",
      };
    case "failed":
    case "needs_attention":
      return {
        error: `Code task status: ${status}`,
        eventKey: codeEventKey,
        outcome: "failed",
        taskId,
        type: "task.ended",
      };
    case "cancelled":
      return {
        eventKey: codeEventKey,
        outcome: "cancelled",
        reason: "Code task cancelled.",
        taskId,
        type: "task.ended",
      };
    case "queued":
    case "running":
      return { eventKey: codeEventKey, taskId, type: "task.started" };
    default:
      return undefined;
  }
}

async function observeCodeTasks(ctx: PlanExecutionContext): Promise<void> {
  if (!isCodeTaskCompletion(ctx.session.auth)) {
    return;
  }
  let current = planState.get();
  if (!current || ctx.session.parent) {
    return;
  }
  for (const { execution } of current.steps) {
    if (!isActiveCodeExecution(execution)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Each bounded code task is observed independently; serial reads preserve reducer order.
    const { task } = await getCodeTask(
      execution.taskId,
      undefined,
      ctx.occurrence.abortSignal
    );
    const status = codeTaskStatus(task);
    if (!status) {
      continue;
    }
    const event = codeTaskEvent(ctx, execution.taskId, status);
    if (event) {
      apply(current, ctx, event);
    }
    const refreshed = planState.get();
    if (refreshed) {
      current = refreshed;
    }
  }
}

async function restorePredecessorPlan(ctx: {
  cancel: (reason?: string) => void;
  occurrence: { abortSignal: AbortSignal };
  session: {
    auth: Parameters<typeof isConsultation>[0];
    id: string;
    parent?: unknown;
    predecessor?: { sessionId: string };
  };
}): Promise<void> {
  if (
    ctx.session.parent ||
    isConsultation(ctx.session.auth) ||
    isRoutineExecution(ctx.session.auth) ||
    isCodeTaskCompletion(ctx.session.auth) ||
    planRecoveryCheck.get() !== "unread"
  ) {
    return;
  }
  if (planState.get()) {
    planRecoveryCheck.update(() => "restored");
    return;
  }
  const lookup = await restorePlanFromHub(
    ctx.session.id,
    ctx.session.predecessor?.sessionId,
    ctx.occurrence.abortSignal
  );
  if (lookup.status === "unavailable") {
    ctx.cancel(
      "Saved plan recovery is temporarily unavailable; retrying this turn."
    );
    return;
  }
  if (lookup.status === "absent") {
    planRecoveryCheck.update(() => "absent");
    return;
  }
  const { plan } = lookup;
  if (planState.get()) {
    planRecoveryCheck.update(() => "restored");
    return;
  }
  planState.update(() => plan);
  resetPlanBudget(plan.id, plan.dispatchCount ?? 0);
  planRecoveryCheck.update(() => "restored");
}

export default defineHook({
  events: {
    "call.settled"(event, ctx) {
      apply(planState.get(), ctx, {
        callId: event.data.callId,
        error: errorText(event.data.error),
        eventKey: eventKey(ctx),
        outcome: event.data.outcome,
        output: event.data.output,
        reason: event.data.reason,
        type: "call.settled",
      });
    },
    "call.started"(event, ctx) {
      apply(planState.get(), ctx, {
        callId: event.data.callId,
        eventKey: eventKey(ctx),
        taskId: event.data.taskId,
        type: "call.started",
      });
    },
    "child.opened"(event, ctx) {
      const { owner } = event.data;
      apply(planState.get(), ctx, {
        callId: "callId" in owner ? owner.callId : undefined,
        childSessionId: event.data.sessionId,
        eventKey: eventKey(ctx),
        taskId: "taskId" in owner ? owner.taskId : undefined,
        type: "child.opened",
      });
    },
    async "delivery.admitted"(_event, ctx) {
      await observeCodeTasks(ctx);
    },
    async "session.started"(_event, ctx) {
      await restorePredecessorPlan(ctx);
    },
    "task.ended"(event, ctx) {
      if (!ctx.session.parent) {
        recordObservedTaskEnd(event.data.taskId);
      }
      apply(planState.get(), ctx, {
        error: errorText(event.data.error),
        eventKey: eventKey(ctx),
        outcome: event.data.outcome,
        reason: event.data.reason,
        taskId: event.data.taskId,
        type: "task.ended",
      });
    },
    "task.started"(event, ctx) {
      if (!ctx.session.parent) {
        recordObservedTaskStart({
          callId: event.data.startedBy.callId,
          kind: event.data.kind,
          name: event.data.name,
          status: "running",
          taskId: event.data.taskId,
          turnId: ctx.turn?.id,
        });
      }
      apply(planState.get(), ctx, {
        callId: event.data.startedBy.callId,
        eventKey: eventKey(ctx),
        kind: event.data.kind,
        name: event.data.name,
        taskId: event.data.taskId,
        type: "task.started",
      });
    },
    async "turn.started"(_event, ctx) {
      await restorePredecessorPlan(ctx);
    },
  },
});
