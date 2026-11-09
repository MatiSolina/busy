import { hubFetch } from "./hub";
import {
  parsePlanRecoveryPacket,
  rebasePlanForReplacement,
} from "./plan-recovery";
import type { TaskPlan } from "./task-plan";

export type PlanRecoveryLookup =
  | { status: "absent" }
  | { status: "restored"; plan: TaskPlan }
  | { status: "unavailable" };

/** Fetch and validate only the hub-owned recovery packet for this session. */
export async function restorePlanFromHub(
  rootSessionId: string,
  predecessorSessionId?: string,
  signal?: AbortSignal
): Promise<PlanRecoveryLookup> {
  let response: Response;
  try {
    response = await hubFetch(
      `/api/bot/recovery?sessionId=${encodeURIComponent(rootSessionId)}`,
      signal ? { signal } : undefined
    );
  } catch {
    return { status: "unavailable" };
  }
  if (!response.ok) {
    return { status: "unavailable" };
  }
  let packet: unknown;
  try {
    const body = (await response.json()) as { packet?: unknown } | unknown;
    packet =
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "packet" in body
        ? body.packet
        : body;
  } catch {
    return { status: "unavailable" };
  }
  if (packet === null) {
    return { status: "absent" };
  }
  const parsed = parsePlanRecoveryPacket(packet, {
    predecessorSessionId,
    rootSessionId,
  });
  if (!parsed) {
    return { status: "unavailable" };
  }
  return {
    plan: rebasePlanForReplacement(parsed.plan, rootSessionId),
    status: "restored",
  };
}
