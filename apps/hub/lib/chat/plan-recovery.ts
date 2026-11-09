import {
  parseTaskPlan,
  type TaskPlan,
} from "../../../../templates/bot/agent/lib/task-plan";
import { recoveryPlanForSession } from "./send";

export interface PlanRecoveryResponse {
  botId: string;
  plan: TaskPlan;
  predecessorSessionId: string | null;
  rootSessionId: string;
  version: 1;
}

/**
 * Returns the immutable full root plan attached to a current recovery tuple.
 * The caller must derive botId from authenticated request state; this helper
 * never accepts a model-supplied bot or predecessor id.
 */
export async function planRecoveryForSession(
  botId: string,
  rootSessionId: string
): Promise<PlanRecoveryResponse | null> {
  const stored = await recoveryPlanForSession(botId, rootSessionId);
  if (!stored) {
    return null;
  }
  const plan = parseTaskPlan({ plan: stored.plan });
  if (!plan) {
    throw new Error("The saved recovery plan could not be validated.");
  }
  return {
    botId: stored.botId,
    plan,
    predecessorSessionId: stored.predecessorSessionId,
    rootSessionId: stored.rootSessionId,
    version: 1,
  };
}
