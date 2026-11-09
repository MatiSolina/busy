import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { rebasePlanForReplacement } from "../../../../templates/bot/agent/lib/plan-recovery";
import {
  parseTaskPlan,
  type TaskPlan,
} from "../../../../templates/bot/agent/lib/task-plan";
import { db, events, sessionRecoveries } from "../db";
import {
  latestRootPlanSnapshot,
  mergeRootPlanEvents,
  type RecoveryEvent,
  rootPlanCallIds,
} from "./recovery";

const MAX_PLAN_CALLS = 256;
const MAX_PLAN_FACTS = MAX_PLAN_CALLS * 4;
const fact = sql`coalesce(${events.data}->'data', ${events.data})`;
const callId = sql<string>`coalesce(${fact}->>'callId', ${fact}#>>'{startedBy,callId}')`;
const coordinates = {
  at: events.at,
  index: events.index,
  line: events.line,
  sessionId: events.sessionId,
  type: events.type,
};

/** Read plan facts separately so a long sequence of other tools cannot evict a plan. */
export async function readRootPlanSnapshot(
  botId: string,
  sessionId: string,
  recent: readonly RecoveryEvent[]
): Promise<TaskPlan | null> {
  const scoped = and(eq(events.botId, botId), eq(events.sessionId, sessionId));
  const [inherited] = await db()
    .select({
      plan: sessionRecoveries.planSnapshot,
      source: sessionRecoveries.sourceSessionId,
    })
    .from(sessionRecoveries)
    .where(
      and(
        eq(sessionRecoveries.botId, botId),
        eq(sessionRecoveries.reservedSessionId, sessionId),
        // A previously activated generation may already be marked failed when
        // its retired target is replaced. Its immutable plan still belongs to it.
        inArray(sessionRecoveries.state, ["active", "completed", "failed"])
      )
    )
    .orderBy(desc(sessionRecoveries.createdAt))
    .limit(1);
  let baseline: TaskPlan | null = null;
  if (inherited?.plan && inherited.source) {
    const parsed = parseTaskPlan({ plan: inherited.plan });
    if (!parsed) {
      throw new Error("The inherited recovery plan could not be validated.");
    }
    baseline = rebasePlanForReplacement(parsed, sessionId);
  }
  const requests = await db()
    .select({
      ...coordinates,
      data: sql<{
        data: { input: { planId?: unknown } | null };
      }>`jsonb_build_object('scope', ${events.data}->'scope', 'data', jsonb_build_object(
        'callId', ${fact}->'callId', 'capability', ${fact}->'capability',
        'input', (${fact}->'input') - 'message'
      ))`,
    })
    .from(events)
    .where(
      and(
        scoped,
        eq(events.type, "call.requested"),
        sql`${events.data}#>>'{scope,taskId}' is null`,
        inArray(sql<string>`${fact}#>>'{capability,name}'`, [
          "manage_plan",
          "bind_plan_execution",
          "dispatch_plan_step",
        ])
      )
    )
    .orderBy(desc(events.line), desc(events.index))
    .limit(MAX_PLAN_CALLS);
  const orderedRequests = requests.toReversed();
  const ids = rootPlanCallIds(orderedRequests);
  if (ids.length === 0) {
    return latestRootPlanSnapshot(recent, baseline);
  }
  const lifecycle = await db()
    .select({
      ...coordinates,
      // A dispatch's child result may be large or private. Only its plan is needed.
      data: sql<unknown>`jsonb_build_object('scope', ${events.data}->'scope', 'data', jsonb_build_object(
        'callId', ${fact}->'callId', 'startedBy', ${fact}->'startedBy',
        'taskId', ${fact}->'taskId', 'outcome', ${fact}->'outcome',
        'output', jsonb_build_object('plan', ${fact}#>'{output,plan}')
      ))`,
    })
    .from(events)
    .where(
      and(
        scoped,
        inArray(callId, ids),
        inArray(events.type, ["call.started", "task.started", "call.settled"])
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(MAX_PLAN_FACTS + 1);
  if (lifecycle.length > MAX_PLAN_FACTS) {
    throw new Error(
      "The saved plan has too many lifecycle facts to recover safely."
    );
  }
  const plan = latestRootPlanSnapshot(
    mergeRootPlanEvents(recent, orderedRequests, lifecycle),
    baseline
  );
  const requiresSnapshot = requests.some(
    (row) => typeof row.data.data.input?.planId === "string"
  );
  if (!plan && (requests.length === MAX_PLAN_CALLS || requiresSnapshot)) {
    throw new Error(
      "The saved plan could not be recovered within its lookup bound."
    );
  }
  return plan;
}
