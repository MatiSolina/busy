import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCodeTask } from "../lib/code-tasks";
import { restorePlanFromHub } from "../lib/plan-recovery-runtime";
import type { PlanExecutionBudget } from "../lib/plan-state";
import {
  planExecutionBudget,
  planRecoveryCheck,
  planState,
} from "../lib/plan-state";
import type { TaskPlan } from "../lib/task-plan";
import hook from "./plan-execution";

const { slots } = vi.hoisted(() => ({ slots: new Map<string, unknown>() }));
vi.mock("eve/context", () => ({
  defineState: (stateName: string, createInitial: () => unknown) => ({
    get: () => (slots.has(stateName) ? slots.get(stateName) : createInitial()),
    update: (fn: (value: unknown) => unknown) => {
      const current = slots.has(stateName)
        ? slots.get(stateName)
        : createInitial();
      slots.set(stateName, fn(current));
    },
  }),
}));
vi.mock("../lib/plan-recovery-runtime", () => ({
  restorePlanFromHub: vi.fn(),
}));
vi.mock("../lib/code-tasks", () => ({
  getCodeTask: vi.fn(),
}));

type Handler = (event: any, ctx: any) => void | Promise<void>;
const handlers = hook.events as Record<string, Handler>;

const initial: TaskPlan = {
  id: "plan-1",
  revision: 2,
  steps: [
    {
      assignee: "agent",
      dependsOn: [],
      execution: {
        id: "exec-1",
        kind: "agent",
        owner: { callId: "call-1", sessionId: "root", turnId: "turn-1" },
        planRevision: 2,
        status: "bound",
        taskId: "task-1",
      },
      expectedResult: "Verified child output",
      id: "work",
      status: "in_progress",
      taskId: "task-1",
      title: "Work",
    },
  ],
  title: "Work",
};

const budget: PlanExecutionBudget = {
  activeExecutionIds: ["exec-1"],
  dispatchesThisTurn: 1,
  planId: "plan-1",
  totalDispatches: 1,
  turnId: "turn-1",
};

const context = (
  line: number,
  index = 0,
  predecessor: string | null = "old-root"
) => ({
  cancel: vi.fn(),
  occurrence: { abortSignal: new AbortController().signal },
  position: { index, line },
  session: {
    auth: { current: { principalId: "root", principalType: "user" } },
    id: "root",
    ...(predecessor ? { predecessor: { sessionId: predecessor } } : {}),
  },
  turn: { id: "turn-1" },
});

beforeEach(() => {
  slots.clear();
  vi.mocked(restorePlanFromHub).mockReset();
  vi.mocked(getCodeTask).mockReset();
  planState.update(() => initial);
  planExecutionBudget.update(() => budget);
  planRecoveryCheck.update(() => "unread");
});

describe("plan execution Eve hook", () => {
  it("restores only the authenticated predecessor packet", async () => {
    planState.update(() => null);
    vi.mocked(restorePlanFromHub).mockResolvedValueOnce({
      plan: {
        ...initial,
        steps: initial.steps.map((step) => ({
          ...step,
          execution: {
            callId: "call-1",
            id: "exec-1",
            kind: "agent" as const,
            owner: { sessionId: "old-root" },
            planRevision: 2,
            status: "blocked" as const,
            taskId: "task-1",
          },
          note: "Recovered predecessor execution is blocked.",
          status: "blocked" as const,
        })),
      },
      status: "restored",
    });
    await handlers["session.started"]({}, context(1));
    expect(restorePlanFromHub).toHaveBeenCalledWith(
      "root",
      "old-root",
      expect.any(AbortSignal)
    );
    expect(planState.get()?.steps[0]?.status).toBe("blocked");
    expect(planState.get()?.steps[0]?.taskId).toBe("task-1");
  });

  it("restores a Hub-created session without an Eve predecessor", async () => {
    planState.update(() => null);
    vi.mocked(restorePlanFromHub).mockResolvedValueOnce({
      plan: initial,
      status: "restored",
    });
    await handlers["session.started"]({}, context(2, 0, null));
    expect(restorePlanFromHub).toHaveBeenCalledWith(
      "root",
      undefined,
      expect.any(AbortSignal)
    );
    expect(planState.get()?.id).toBe("plan-1");
  });

  it("cancels on unavailable recovery and retries on the next turn", async () => {
    planState.update(() => null);
    vi.mocked(restorePlanFromHub)
      .mockResolvedValueOnce({ status: "unavailable" })
      .mockResolvedValueOnce({ plan: initial, status: "restored" });
    const first = context(3, 0, null);
    await handlers["session.started"]({}, first);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(planState.get()).toBeNull();
    await handlers["turn.started"]({}, context(4, 0, null));
    expect(restorePlanFromHub).toHaveBeenCalledTimes(2);
    expect(planState.get()?.id).toBe("plan-1");
  });

  it("follows actual task/call settlement and ignores replay", async () => {
    await handlers["task.started"](
      {
        data: {
          kind: "agent",
          name: "agent",
          startedBy: { callId: "call-1" },
          taskId: "task-1",
        },
      },
      context(10)
    );
    expect(planState.get()?.steps[0]?.execution?.status).toBe("running");

    await handlers["call.settled"](
      {
        data: {
          callId: "call-1",
          outcome: "completed",
          output: { result: "available" },
        },
      },
      context(11)
    );
    expect(planState.get()?.steps[0]).toMatchObject({
      execution: { status: "completed" },
      status: "in_progress",
    });
    const revision = planState.get()?.revision;

    await handlers["call.settled"](
      {
        data: {
          callId: "call-1",
          outcome: "completed",
          output: { result: "available" },
        },
      },
      context(11)
    );
    expect(planState.get()?.revision).toBe(revision);
  });

  it("observes authenticated code-task status without trusting notification text", async () => {
    const codeTaskId = "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a";
    planState.update(() => ({
      ...initial,
      steps: [
        {
          ...initial.steps[0],
          execution: {
            callId: "code-call",
            id: "code-exec",
            kind: "code",
            owner: { callId: "code-call", sessionId: "root" },
            planRevision: 2,
            status: "running",
            taskId: codeTaskId,
          },
          status: "in_progress",
          taskId: codeTaskId,
        },
      ],
    }));
    vi.mocked(getCodeTask).mockResolvedValueOnce({
      task: { status: "ready" },
    });
    const completionContext = context(30);
    completionContext.session.auth = {
      current: {
        principalId: `busy-hub:hub:code-task:${codeTaskId}`,
        principalType: "service",
      },
    };
    await handlers["delivery.admitted"]({}, completionContext);
    expect(planState.get()?.steps[0]?.execution?.status).toBe("completed");
  });
});
