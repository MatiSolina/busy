import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanExecutionBudget, RunningTaskLike } from "./plan-state";
import {
  bindPlanExecution,
  canManagePlan,
  observePlanExecution,
  PLAN_EXECUTION_LIMITS,
  planExecutionBudget,
  resetPlanBudget,
} from "./plan-state";
import type { PlanStep, TaskPlan } from "./task-plan";

const { slots } = vi.hoisted(() => ({ slots: new Map<string, unknown>() }));
vi.mock("eve/context", () => ({
  defineState: (name: string, initial: () => unknown) => ({
    get: () => (slots.has(name) ? slots.get(name) : initial()),
    update: (fn: (value: unknown) => unknown) => {
      const current = slots.has(name) ? slots.get(name) : initial();
      slots.set(name, fn(current));
    },
  }),
}));

const step = (id: string, dependsOn: string[] = []): PlanStep => ({
  assignee: "self",
  dependsOn,
  expectedResult: "A verified result",
  id,
  status: "pending",
  title: id,
});

const plan = (steps: PlanStep[] = [step("work")]): TaskPlan => ({
  id: "plan-1",
  revision: 1,
  steps,
  title: "Work",
});

const budget = (
  over: Partial<PlanExecutionBudget> = {}
): PlanExecutionBudget => ({
  activeExecutionIds: [],
  dispatchesThisTurn: 0,
  planId: "plan-1",
  totalDispatches: 0,
  turnId: "turn-1",
  ...over,
});

const owner = (turnId = "turn-1") => ({
  callId: "call-root",
  sessionId: "root",
  turnId,
});

const task = (taskId: string, name = "agent"): RunningTaskLike => ({
  callId: "call-agent",
  kind: "agent",
  name,
  status: "running",
  taskId,
});

beforeEach(() => slots.clear());

describe("root plan execution bindings", () => {
  it("records failure metadata without copying raw provider errors into the plan", () => {
    const bound = bindPlanExecution(plan(), budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "work",
      taskId: "dispatch-1",
    });
    const observed = observePlanExecution(
      bound.mutation.plan,
      bound.budget,
      {
        callId: "call-root",
        error: "Authorization: Bearer private-provider-token",
        eventKey: "10:0",
        outcome: "failed",
        reason: "api_key=private-provider-key",
        type: "call.settled",
      },
      "root"
    );

    expect(observed.mutation.execution?.status).toBe("failed");
    expect(observed.mutation.plan.steps[0]?.status).toBe("failed");
    expect(JSON.stringify(observed.mutation.plan)).not.toContain(
      "private-provider"
    );
    expect(observed.mutation.plan.steps[0]?.note).toContain("recorded result");
  });

  it("ignores the binding tool's receipt when the remote code job is still running", () => {
    const bound = bindPlanExecution(plan(), budget(), {
      kind: "code",
      owner: owner(),
      planId: "plan-1",
      revision: 1,
      stepId: "work",
      taskId: "11111111-1111-4111-8111-111111111111",
    });
    const observed = observePlanExecution(
      bound.mutation.plan,
      bound.budget,
      {
        callId: "call-root",
        eventKey: "10:0",
        outcome: "completed",
        output: { executionId: bound.mutation.execution?.id },
        type: "call.settled",
      },
      "root"
    );

    expect(observed.mutation.changed).toBe(false);
    expect(observed.mutation.plan.steps[0]?.execution?.status).toBe("bound");
  });

  it("keeps a cancelled plan step cancelled when a late cancellation settles", () => {
    const bound = bindPlanExecution(plan(), budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "work",
      taskId: "dispatch-1",
    });
    const cancelled: TaskPlan = {
      ...bound.mutation.plan,
      steps: bound.mutation.plan.steps.map((item) => ({
        ...item,
        note: "The user cancelled this work.",
        status: "cancelled",
      })),
    };
    const observed = observePlanExecution(
      cancelled,
      bound.budget,
      {
        callId: "call-root",
        eventKey: "10:0",
        outcome: "cancelled",
        type: "call.settled",
      },
      "root"
    );
    expect(observed.mutation.plan.steps[0]).toMatchObject({
      note: "The user cancelled this work.",
      status: "cancelled",
    });
  });

  it("ignores an old start after settlement while allowing a new correction", () => {
    const bound = bindPlanExecution(
      plan(),
      budget(),
      {
        kind: "agent",
        owner: { ...owner(), callId: "call-agent" },
        planId: "plan-1",
        revision: 1,
        stepId: "work",
        taskId: "agent-task",
      },
      task("agent-task")
    );
    const completed = observePlanExecution(
      bound.mutation.plan,
      bound.budget,
      {
        callId: "call-agent",
        eventKey: "20:0",
        outcome: "completed",
        type: "call.settled",
      },
      "root"
    );
    const replay = observePlanExecution(
      completed.mutation.plan,
      completed.budget,
      {
        callId: "call-agent",
        eventKey: "10:0",
        taskId: "agent-task",
        type: "call.started",
      },
      "root"
    );
    expect(replay.mutation.changed).toBe(false);
    const correction = observePlanExecution(
      completed.mutation.plan,
      completed.budget,
      {
        callId: "new-correction",
        eventKey: "30:0",
        taskId: "agent-task",
        type: "call.started",
      },
      "root"
    );
    expect(correction.mutation.execution?.status).toBe("running");
  });

  it("reserves before dispatch, observes running and never fabricates completion", () => {
    const reserved = bindPlanExecution(plan(), budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "work",
      taskId: "dispatch-1",
    });
    expect(reserved.mutation.plan.steps[0]?.status).toBe("in_progress");
    expect(reserved.mutation.execution?.status).toBe("bound");

    const running = observePlanExecution(
      reserved.mutation.plan,
      reserved.budget,
      {
        callId: "call-root",
        eventKey: "10:0",
        taskId: "eve-task-1",
        type: "task.started",
      },
      "root"
    );
    expect(running.mutation.plan.steps[0]?.execution).toMatchObject({
      status: "running",
      taskId: "eve-task-1",
    });

    const settled = observePlanExecution(
      running.mutation.plan,
      running.budget,
      {
        callId: "call-root",
        eventKey: "11:0",
        outcome: "completed",
        output: { summary: "child result" },
        type: "call.settled",
      },
      "root"
    );
    expect(settled.mutation.plan.steps[0]).toMatchObject({
      execution: {
        resultEvidence:
          "Settled structured result available for root verification.",
        status: "completed",
      },
      status: "in_progress",
    });
    expect(settled.mutation.plan.steps[0]?.status).not.toBe("completed");

    const continued = observePlanExecution(
      {
        ...settled.mutation.plan,
        steps: settled.mutation.plan.steps.map((candidate) => ({
          ...candidate,
          note: "Verified result",
          status: "completed" as const,
        })),
      },
      settled.budget,
      {
        callId: "follow-up-call",
        eventKey: "12:0",
        taskId: "eve-task-1",
        type: "call.started",
      },
      "root"
    );
    expect(continued.mutation.plan.steps[0]?.status).toBe("in_progress");
    expect(continued.mutation.execution?.status).toBe("running");
  });

  it("rejects stale or mismatched bindings and replays the same binding", () => {
    const first = bindPlanExecution(plan(), budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "work",
      taskId: "dispatch-1",
    });
    expect(
      bindPlanExecution(first.mutation.plan, first.budget, {
        kind: "agent",
        owner: owner(),
        planId: "plan-1",
        preDispatch: true,
        revision: 1,
        stepId: "work",
        taskId: "dispatch-1",
      }).mutation.changed
    ).toBe(false);
    expect(() =>
      bindPlanExecution(first.mutation.plan, first.budget, {
        kind: "agent",
        owner: owner(),
        planId: "plan-1",
        preDispatch: true,
        revision: 1,
        stepId: "work",
        taskId: "dispatch-2",
      })
    ).toThrow("revision changed");
  });

  it("keeps the server dispatch count across cleared bindings and restores the limit", () => {
    const first = bindPlanExecution(plan(), budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "work",
      taskId: "dispatch-1",
    });
    const cleared: TaskPlan = {
      ...first.mutation.plan,
      revision: first.mutation.plan.revision + 1,
      steps: first.mutation.plan.steps.map((item) => ({
        ...item,
        execution: undefined,
        status: "pending" as const,
        taskId: undefined,
      })),
    };
    const second = bindPlanExecution(cleared, first.budget, {
      kind: "agent",
      owner: owner("turn-2"),
      planId: "plan-1",
      preDispatch: true,
      revision: cleared.revision,
      stepId: "work",
      taskId: "dispatch-2",
    });
    expect(first.mutation.plan.dispatchCount).toBe(1);
    expect(second.mutation.plan.dispatchCount).toBe(2);
    expect(second.budget.totalDispatches).toBe(2);

    resetPlanBudget("plan-1", 19);
    expect(planExecutionBudget.get().totalDispatches).toBe(19);
    const twentieth = bindPlanExecution(
      { ...plan(), dispatchCount: 19 },
      planExecutionBudget.get(),
      {
        kind: "agent",
        owner: owner("turn-3"),
        planId: "plan-1",
        preDispatch: true,
        revision: 1,
        stepId: "work",
        taskId: "dispatch-20",
      }
    );
    expect(twentieth.mutation.plan.dispatchCount).toBe(20);
    expect(() =>
      bindPlanExecution({ ...plan(), dispatchCount: 20 }, twentieth.budget, {
        kind: "agent",
        owner: owner("turn-4"),
        planId: "plan-1",
        preDispatch: true,
        revision: 1,
        stepId: "work",
        taskId: "dispatch-21",
      })
    ).toThrow("Plan execution budget exhausted");
  });

  it("marks failures and dependent work blocked, idempotently", () => {
    const initial = plan([step("research"), step("write", ["research"])]);
    const bound = bindPlanExecution(initial, budget(), {
      kind: "agent",
      owner: owner(),
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      stepId: "research",
      taskId: "dispatch-1",
    });
    const failed = observePlanExecution(
      bound.mutation.plan,
      bound.budget,
      {
        eventKey: "20:0",
        outcome: "failed",
        reason: "child crashed",
        taskId: "dispatch-1",
        type: "task.ended",
      },
      "root"
    );
    expect(failed.mutation.plan.steps).toMatchObject([
      { status: "failed" },
      { status: "blocked" },
    ]);
    const replay = observePlanExecution(
      failed.mutation.plan,
      failed.budget,
      {
        eventKey: "20:0",
        outcome: "failed",
        reason: "child crashed",
        taskId: "dispatch-1",
        type: "task.ended",
      },
      "root"
    );
    expect(replay.mutation.changed).toBe(false);
    expect(replay.mutation.plan.revision).toBe(failed.mutation.plan.revision);
  });

  it("enforces the root-turn budget before five dispatches", () => {
    let current = plan(
      Array.from({ length: PLAN_EXECUTION_LIMITS.perRootTurn + 1 }, (_, i) =>
        step(`step-${i}`)
      )
    );
    let currentBudget = budget();
    for (let index = 0; index < PLAN_EXECUTION_LIMITS.perRootTurn; index += 1) {
      const result = bindPlanExecution(current, currentBudget, {
        kind: "agent",
        owner: owner(),
        planId: "plan-1",
        preDispatch: true,
        revision: current.revision,
        stepId: `step-${index}`,
        taskId: `dispatch-${index}`,
      });
      current = result.mutation.plan;
      currentBudget = result.budget;
    }
    expect(() =>
      bindPlanExecution(current, currentBudget, {
        kind: "agent",
        owner: owner(),
        planId: "plan-1",
        preDispatch: true,
        revision: current.revision,
        stepId: "step-4",
        taskId: "dispatch-4",
      })
    ).toThrow("Root-turn plan execution budget exhausted");
  });

  it("keeps peer bindings read-only and scoped to peer tasks", () => {
    expect(() =>
      bindPlanExecution(
        plan(),
        budget(),
        {
          kind: "peer",
          owner: owner(),
          planId: "plan-1",
          revision: 1,
          stepId: "work",
          taskId: "peer-task",
        },
        task("peer-task", "agent")
      )
    ).toThrow("peer binding");
    expect(
      bindPlanExecution(
        plan(),
        budget(),
        {
          kind: "peer",
          owner: owner(),
          planId: "plan-1",
          revision: 1,
          stepId: "work",
          taskId: "peer-task",
        },
        task("peer-task", "peer-1")
      ).mutation.execution?.kind
    ).toBe("peer");
    expect(canManagePlan({ auth: { current: null }, parent: {} })).toBe(false);
    expect(() =>
      bindPlanExecution(
        plan(),
        budget(),
        {
          kind: "agent",
          owner: owner("turn-1"),
          planId: "plan-1",
          revision: 1,
          stepId: "work",
          taskId: "agent-task",
        },
        { ...task("agent-task"), turnId: "turn-2" }
      )
    ).toThrow("different root turn");
  });
});
