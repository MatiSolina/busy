import { describe, expect, it } from "vitest";
import {
  parsePlanRecoveryPacket,
  rebasePlanForReplacement,
} from "./plan-recovery";
import type { TaskPlan } from "./task-plan";

const plan: TaskPlan = {
  id: "plan-1",
  revision: 3,
  steps: [
    {
      assignee: "agent",
      dependsOn: [],
      execution: {
        id: "exec-1",
        kind: "agent",
        owner: { sessionId: "old-root", turnId: "turn-1" },
        planRevision: 2,
        status: "running",
        taskId: "old-task",
      },
      expectedResult: "A verified result",
      id: "work",
      status: "in_progress",
      taskId: "old-task",
      title: "Work",
    },
  ],
  title: "Work",
};

const packet = {
  botId: "bot-1",
  plan,
  predecessorSessionId: "old-root",
  rootSessionId: "new-root",
  version: 1,
};

describe("structured plan recovery", () => {
  it("requires exact hub-scoped bot and session lineage", () => {
    expect(
      parsePlanRecoveryPacket(packet, {
        botId: "bot-1",
        predecessorSessionId: "old-root",
        rootSessionId: "new-root",
      })?.plan.id
    ).toBe("plan-1");
    expect(
      parsePlanRecoveryPacket(
        { ...packet, predecessorSessionId: "attacker" },
        {
          botId: "bot-1",
          predecessorSessionId: "old-root",
          rootSessionId: "new-root",
        }
      )
    ).toBeNull();
    expect(
      parsePlanRecoveryPacket(
        { text: "<prior_history>not a packet</prior_history>" },
        {
          botId: "bot-1",
          predecessorSessionId: "old-root",
          rootSessionId: "new-root",
        }
      )
    ).toBeNull();
  });

  it("preserves predecessor task ids as blocked historical work", () => {
    const restored = rebasePlanForReplacement(plan, "new-root");
    expect(restored.revision).toBe(plan.revision + 1);
    expect(restored.steps[0]).toMatchObject({
      note: expect.stringContaining("predecessor"),
      status: "blocked",
      taskId: "old-task",
    });
    expect(restored.steps[0]?.execution).toMatchObject({
      status: "blocked",
      taskId: "old-task",
    });
  });

  it("keeps a pre-dispatch recovery binding schema-valid without inventing a task id", () => {
    const preDispatch: TaskPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0],
          execution: {
            dispatchKey: "dispatch-root-call",
            id: "exec-1",
            kind: "agent",
            owner: { callId: "root-call", sessionId: "old-root" },
            planRevision: 2,
            status: "bound",
            taskId: undefined,
          },
          status: "in_progress",
          taskId: undefined,
        },
      ],
    };
    const restored = rebasePlanForReplacement(preDispatch, "new-root");
    expect(
      parsePlanRecoveryPacket(
        { ...packet, plan: restored },
        {
          botId: "bot-1",
          predecessorSessionId: "old-root",
          rootSessionId: "new-root",
        }
      )?.plan.steps[0]
    ).toMatchObject({
      execution: { dispatchKey: "dispatch-root-call", status: "blocked" },
      status: "blocked",
    });
  });

  it("preserves a cancelled predecessor step while blocking its historical execution", () => {
    const cancelled: TaskPlan = {
      ...plan,
      steps: [
        {
          ...plan.steps[0],
          note: "Cancelled by the root session.",
          status: "cancelled",
        },
      ],
    };
    const restored = rebasePlanForReplacement(cancelled, "new-root");
    expect(restored.steps[0]).toMatchObject({
      note: "Cancelled by the root session.",
      status: "cancelled",
    });
    expect(restored.steps[0]?.execution).toMatchObject({
      status: "blocked",
      taskId: "old-task",
    });
  });

  it("blocks an older plan's recorded task even without a structured execution binding", () => {
    const legacy: TaskPlan = {
      ...plan,
      steps: [{ ...plan.steps[0], execution: undefined }],
    };
    const restored = rebasePlanForReplacement(legacy, "new-root");
    expect(restored.steps[0]).toMatchObject({
      status: "blocked",
      taskId: "old-task",
    });
    expect(restored.steps[0]?.execution).toBeUndefined();
    expect(
      parsePlanRecoveryPacket(
        { ...packet, plan: restored },
        {
          rootSessionId: "new-root",
        }
      )?.plan
    ).toEqual(restored);
  });
});
