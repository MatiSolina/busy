import { beforeEach, describe, expect, it, vi } from "vitest";

const { recoveryPlanForSession } = vi.hoisted(() => ({
  recoveryPlanForSession: vi.fn(),
}));
vi.mock("@/lib/chat/send", () => ({ recoveryPlanForSession }));

const { planRecoveryForSession } = await import("@/lib/chat/plan-recovery");

beforeEach(() => {
  recoveryPlanForSession.mockReset().mockResolvedValue(null);
});

describe("saved plan recovery", () => {
  it("returns absent only when no scoped snapshot exists", async () => {
    await expect(
      planRecoveryForSession("bot", "replacement")
    ).resolves.toBeNull();
    expect(recoveryPlanForSession).toHaveBeenCalledWith("bot", "replacement");
  });

  it("preserves the full validated plan and trusted lineage", async () => {
    const plan = {
      id: "plan-1",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "Verified result",
          id: "work",
          note: "Inspect the predecessor task before resuming.",
          status: "blocked",
          taskId: "prior-task",
          title: "Inspect prior work",
        },
      ],
      title: "Saved work",
    };
    recoveryPlanForSession.mockResolvedValue({
      botId: "bot",
      plan,
      predecessorSessionId: "predecessor",
      rootSessionId: "replacement",
    });
    await expect(planRecoveryForSession("bot", "replacement")).resolves.toEqual(
      {
        botId: "bot",
        plan,
        predecessorSessionId: "predecessor",
        rootSessionId: "replacement",
        version: 1,
      }
    );
  });

  it("fails closed when a stored snapshot cannot be validated", async () => {
    recoveryPlanForSession.mockResolvedValue({
      botId: "bot",
      plan: { id: "corrupted", revision: 2, steps: [] },
      predecessorSessionId: "predecessor",
      rootSessionId: "replacement",
    });
    await expect(planRecoveryForSession("bot", "replacement")).rejects.toThrow(
      "The saved recovery plan could not be validated."
    );
  });
});
