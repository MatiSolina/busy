import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservePlanExecution } from "./plan-dispatch-step";
import {
  observedPlanTasks,
  planExecutionBudget,
  planState,
} from "./plan-state";
import type { TaskPlan } from "./task-plan";

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

const plan: TaskPlan = {
  dispatchCount: 0,
  id: "plan-1",
  revision: 1,
  steps: [
    {
      assignee: "agent",
      dependsOn: [],
      expectedResult: "Verified output",
      id: "work",
      status: "pending",
      title: "Work",
    },
  ],
  title: "Work",
};

beforeEach(() => {
  slots.clear();
  planState.update(() => plan);
  planExecutionBudget.update(() => ({
    activeExecutionIds: [],
    dispatchesThisTurn: 0,
    planId: "plan-1",
    totalDispatches: 0,
    turnId: "turn-1",
  }));
  observedPlanTasks.update(() => []);
});

describe("plan dispatch reservation", () => {
  it("links a task that started before reservation without inventing its id", async () => {
    observedPlanTasks.update(() => [
      {
        callId: "dispatch-call",
        kind: "agent",
        name: "agent",
        status: "running",
        taskId: "eve-task-real",
      },
    ]);

    const input = {
      callId: "dispatch-call",
      kind: "agent" as const,
      owner: {
        callId: "dispatch-call",
        sessionId: "root",
        turnId: "turn-1",
      },
      planId: "plan-1",
      preDispatch: true,
      revision: 1,
      sessionId: "root",
      stepId: "work",
    };
    const first = await reservePlanExecution(input);
    const synthetic = first.taskId;
    expect(synthetic).not.toBe("eve-task-real");
    expect(first.mutation.plan.steps[0]).toMatchObject({
      execution: {
        dispatchKey: synthetic,
        status: "running",
        taskId: "eve-task-real",
      },
      status: "in_progress",
      taskId: "eve-task-real",
    });
    expect(first.budget.totalDispatches).toBe(1);
    expect(first.budget.activeExecutionIds).toHaveLength(1);

    const replay = await reservePlanExecution(input);
    expect(replay.mutation.changed).toBe(false);
    expect(replay.budget.totalDispatches).toBe(1);
    expect(replay.mutation.plan.steps[0]?.taskId).toBe("eve-task-real");
  });
});
