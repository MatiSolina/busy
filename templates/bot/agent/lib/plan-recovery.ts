import type { PlanExecution, TaskPlan } from "./task-plan";
import { parseTaskPlan } from "./task-plan";

export const PLAN_RECOVERY_PACKET_VERSION = 1 as const;

/**
 * A hub-authenticated packet used only when Eve starts a replacement root
 * session. The hub must authenticate and scope this object before handing it
 * to the bot; this parser never treats prior_history or arbitrary text as a
 * recovery packet.
 */
export interface PlanRecoveryPacket {
  botId: string;
  plan: TaskPlan;
  predecessorSessionId: string;
  rootSessionId: string;
  version: typeof PLAN_RECOVERY_PACKET_VERSION;
}

export interface PlanRecoveryExpectation {
  botId?: string;
  predecessorSessionId?: string;
  rootSessionId: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}

/** Validate a trusted hub packet and its exact session lineage. */
export function parsePlanRecoveryPacket(
  value: unknown,
  expected: PlanRecoveryExpectation
): PlanRecoveryPacket | null {
  if (!record(value)) {
    return null;
  }
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        ![
          "botId",
          "plan",
          "predecessorSessionId",
          "rootSessionId",
          "version",
        ].includes(key)
    )
  ) {
    return null;
  }
  if (
    value.version !== PLAN_RECOVERY_PACKET_VERSION ||
    !text(value.botId, 200) ||
    !text(value.rootSessionId, 200) ||
    !text(value.predecessorSessionId, 200) ||
    (expected.botId !== undefined && value.botId !== expected.botId) ||
    value.rootSessionId !== expected.rootSessionId ||
    (expected.predecessorSessionId !== undefined &&
      value.predecessorSessionId !== expected.predecessorSessionId)
  ) {
    return null;
  }
  const plan = parseTaskPlan({ plan: value.plan });
  return plan
    ? {
        botId: value.botId,
        plan,
        predecessorSessionId: value.predecessorSessionId,
        rootSessionId: value.rootSessionId,
        version: PLAN_RECOVERY_PACKET_VERSION,
      }
    : null;
}

function isActiveExecution(execution: PlanExecution): boolean {
  return execution.status === "bound" || execution.status === "running";
}

/**
 * Rebase active delegated work onto a replacement root. Eve cannot resume an
 * old task from a new session, so those bindings stay historical and blocked;
 * the root must inspect/cancel them before an explicit replacement binding.
 */
export function rebasePlanForReplacement(
  plan: TaskPlan,
  replacementSessionId: string
): TaskPlan {
  let changed = false;
  const steps = plan.steps.map((step) => {
    const { execution } = step;
    if (!execution && step.taskId && step.status === "in_progress") {
      changed = true;
      return {
        ...step,
        note: "Recovered predecessor task is blocked; inspect its recorded result before continuing.",
        status: "blocked" as const,
      };
    }
    if (!(execution && isActiveExecution(execution))) {
      return step;
    }
    if (execution.owner.sessionId === replacementSessionId) {
      return step;
    }
    changed = true;
    const keepCancelled = step.status === "cancelled";
    return {
      ...step,
      execution: {
        ...execution,
        dispatchKey:
          execution.dispatchKey ?? execution.owner.callId ?? execution.id,
        failureReason:
          "Predecessor execution is not resumable from the replacement session.",
        status: "blocked" as const,
      },
      ...(keepCancelled
        ? {}
        : {
            note: "Recovered predecessor execution is blocked; inspect or cancel it before replacing.",
            status: "blocked" as const,
          }),
    };
  });
  return changed ? { ...plan, revision: plan.revision + 1, steps } : plan;
}
