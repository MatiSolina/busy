import { describe, expect, it } from "vitest";
import type { TaskPlan } from "../../../../templates/bot/agent/lib/task-plan";
import {
  callSettled,
  requested,
  row,
  seq,
  settled,
  started,
  view,
} from "./chat.test-helpers";

const plan: TaskPlan = {
  id: "plan-proposal",
  revision: 1,
  steps: [
    {
      assignee: "agent",
      dependsOn: [],
      expectedResult: "Verified proposal",
      id: "write",
      status: "in_progress",
      taskId: "task-1",
      title: "Write proposal",
    },
  ],
  title: "Acme proposal",
};

describe("plan chat replay", () => {
  it("updates one card in place and ignores a stale revision after reconnect", () => {
    const updated = {
      ...plan,
      revision: 2,
      steps: [
        { ...plan.steps[0], note: "Proposal verified", status: "completed" },
      ],
    };
    const rows = seq(
      requested("create", "manage_plan", { action: "create" }),
      callSettled("create", "completed", { plan }),
      requested("update", "manage_plan", { action: "update" }),
      callSettled("update", "completed", { plan: updated }),
      requested("read", "manage_plan", { action: "get" }),
      callSettled("read", "completed", { plan })
    );
    expect(view([...rows, ...rows]).items).toEqual([
      { id: `plan:${plan.id}`, kind: "plan", plan: updated },
    ]);
  });

  it("preserves the previous plan when an update fails or returns invalid data", () => {
    const rows = seq(
      requested("create", "manage_plan"),
      callSettled("create", "completed", { plan }),
      requested("update", "manage_plan"),
      callSettled("update", "failed", { plan: { ...plan, revision: 2 } }),
      requested("invalid", "manage_plan"),
      callSettled("invalid", "completed", { plan: { ...plan, steps: [] } })
    );
    expect(view(rows).items.filter((item) => item.kind === "plan")).toEqual([
      { id: `plan:${plan.id}`, kind: "plan", plan },
    ]);
    expect(view(rows).items).toContainEqual(
      expect.objectContaining({
        id: "update",
        kind: "activity",
        state: "error",
      })
    );
  });

  it("does not accept a plan from unrelated tools or delegated task output", () => {
    const delegated = row(2, "call.requested", {
      callId: "child",
      capability: { name: "manage_plan" },
    });
    delegated.data.scope = { taskId: "child-task" };
    const rows = [
      ...seq(
        requested("other", "read_file"),
        callSettled("other", "completed", { plan })
      ),
      delegated,
      row(3, "call.settled", {
        callId: "child",
        outcome: "completed",
        output: { plan },
      }),
    ];
    expect(view(rows).items.some((item) => item.kind === "plan")).toBe(false);
  });

  it("shows stopped work as paused until the agent records new progress", () => {
    const rows = seq(
      started("turn-1"),
      requested("create", "manage_plan"),
      callSettled("create", "completed", { plan }),
      settled("turn-1", "cancelled")
    );
    expect(view(rows).items).toContainEqual({
      id: `plan:${plan.id}`,
      kind: "plan",
      paused: true,
      plan,
    });
    const resumed = [
      ...rows,
      row(4, "call.requested", {
        callId: "update",
        capability: { name: "manage_plan" },
      }),
      row(5, "call.settled", {
        callId: "update",
        outcome: "completed",
        output: { plan: { ...plan, revision: 2 } },
      }),
    ];
    expect(
      view(resumed).items.find((item) => item.kind === "plan")
    ).not.toHaveProperty("paused");
  });
});
