import { describe, expect, it } from "vitest";
import type { TaskPlan } from "../../../../templates/bot/agent/lib/task-plan";
import {
  buildRecoveryPacket,
  latestRootPlanSnapshot,
  mergeRootPlanEvents,
  rootPlanCallIds,
  withoutUnprovenPlan,
} from "./recovery";

const plan = {
  plan: {
    id: "plan-1",
    revision: 2,
    steps: [
      {
        assignee: "agent",
        dependsOn: [],
        expectedResult: "never copied into the packet",
        id: "inspect",
        note: "private note must stay out",
        status: "in_progress",
        title: "Inspect the evidence",
      },
    ],
    title: "Recover the work",
  },
};

describe("durable recovery packets", () => {
  it("merges directed historical plan events and returns their root call ids", () => {
    const requested = {
      at: "2026-11-09T10:00:00.000Z",
      data: {
        callId: "plan-1",
        capability: { name: "manage_plan" },
        input: { action: "create" },
      },
      index: 0,
      line: 1,
      sessionId: "old",
      type: "call.requested",
    } as const;
    const settled = {
      ...requested,
      at: "2026-11-09T10:00:01.000Z",
      data: { callId: "plan-1", outcome: "completed" },
      line: 2,
      type: "call.settled",
    } as const;
    const merged = mergeRootPlanEvents([settled], [requested, settled]);
    expect(rootPlanCallIds(merged)).toEqual(["plan-1"]);
    expect(merged.map((row) => row.line)).toEqual([1, 2]);
    expect(
      rootPlanCallIds([
        {
          ...requested,
          data: {
            callId: "child-plan",
            capability: { name: "manage_plan" },
            scope: { taskId: "child-task" },
          },
          line: 3,
        },
      ])
    ).toEqual([]);
  });

  it("blocks a dispatch requested before child settlement without trusting its task id", () => {
    const current = {
      id: "plan-1",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "Verified output",
          id: "inspect",
          status: "pending",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const snapshot = latestRootPlanSnapshot([
      {
        at: "2026-11-09T10:00:00.000Z",
        data: {
          callId: "plan-1",
          capability: { name: "manage_plan" },
          input: { action: "create" },
          output: undefined,
        },
        index: 0,
        line: 1,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:01.000Z",
        data: {
          callId: "plan-1",
          outcome: "completed",
          output: { plan: current },
        },
        index: 0,
        line: 2,
        sessionId: "old",
        type: "call.settled",
      },
      {
        at: "2026-11-09T10:00:02.000Z",
        data: {
          callId: "dispatch-1",
          capability: { name: "dispatch_plan_step" },
          input: {
            message: "inspect",
            planId: "plan-1",
            revision: 2,
            stepId: "inspect",
            target: "agent",
          },
        },
        index: 0,
        line: 3,
        sessionId: "old",
        type: "call.requested",
      },
    ]);
    expect(snapshot?.steps[0]).toMatchObject({
      note: expect.stringContaining("dispatch was requested"),
      status: "blocked",
    });
    expect(snapshot?.dispatchCount).toBe(1);
    expect(snapshot?.steps[0]?.taskId).toBeUndefined();
  });

  it("keeps a bind result as the latest full root snapshot without a later get", () => {
    const boundPlan = {
      id: "plan-1",
      revision: 3,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          execution: {
            id: "exec-1",
            kind: "agent",
            owner: { sessionId: "old-root" },
            planRevision: 3,
            status: "bound",
            taskId: "eve-task-1",
          },
          expectedResult: "Verified output",
          id: "inspect",
          status: "in_progress",
          taskId: "eve-task-1",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const snapshot = latestRootPlanSnapshot([
      {
        at: "2026-11-09T10:00:00.000Z",
        data: {
          callId: "bind-1",
          capability: { name: "bind_plan_execution" },
          input: {
            kind: "agent",
            planId: "plan-1",
            revision: 2,
            stepId: "inspect",
            taskId: "eve-task-1",
          },
        },
        index: 0,
        line: 1,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:00.500Z",
        data: { callId: "bind-1", taskId: "binding-helper-task" },
        index: 1,
        line: 1,
        sessionId: "old",
        type: "call.started",
      },
      {
        at: "2026-11-09T10:00:01.000Z",
        data: {
          callId: "bind-1",
          outcome: "completed",
          output: { executionId: "exec-1", plan: boundPlan, status: "bound" },
        },
        index: 0,
        line: 2,
        sessionId: "old",
        type: "call.settled",
      },
    ]);
    expect(snapshot).toEqual(boundPlan);
  });

  it("preserves an authentic task id when the dispatch result follows task.started", () => {
    const initialPlan = {
      id: "plan-1",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "Verified output",
          id: "inspect",
          status: "pending",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const reservationPlan = {
      ...initialPlan,
      dispatchCount: 1,
      revision: 3,
      steps: [
        {
          ...initialPlan.steps[0],
          execution: {
            dispatchKey: "dispatch-key",
            id: "exec-1",
            kind: "agent",
            owner: { callId: "dispatch-1", sessionId: "old" },
            planRevision: 3,
            status: "bound",
          },
          note: "A delegated dispatch was requested before the session ended; inspect it before retrying.",
          status: "blocked",
        },
      ],
    };
    const snapshot = latestRootPlanSnapshot([
      {
        at: "2026-11-09T10:00:00.000Z",
        data: {
          callId: "plan-1",
          capability: { name: "manage_plan" },
          input: { action: "create" },
        },
        index: 0,
        line: 1,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:01.000Z",
        data: {
          callId: "plan-1",
          outcome: "completed",
          output: { plan: initialPlan },
        },
        index: 0,
        line: 2,
        sessionId: "old",
        type: "call.settled",
      },
      {
        at: "2026-11-09T10:00:02.000Z",
        data: {
          callId: "dispatch-1",
          capability: { name: "dispatch_plan_step" },
          input: {
            message: "inspect",
            planId: "plan-1",
            revision: 2,
            stepId: "inspect",
            target: "agent",
          },
        },
        index: 0,
        line: 3,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:03.000Z",
        data: { callId: "dispatch-1", taskId: "eve-task-1" },
        index: 0,
        line: 4,
        sessionId: "old",
        type: "task.started",
      },
      {
        at: "2026-11-09T10:00:04.000Z",
        data: {
          callId: "dispatch-1",
          outcome: "completed",
          output: { executionId: "exec-1", plan: reservationPlan },
        },
        index: 0,
        line: 5,
        sessionId: "old",
        type: "call.settled",
      },
    ]);
    expect(snapshot?.steps[0]).toMatchObject({
      execution: { dispatchKey: "dispatch-key", taskId: "eve-task-1" },
      status: "blocked",
      taskId: "eve-task-1",
    });
  });

  it("does not let lifecycle identity observations hide a later cancellation", () => {
    const initialPlan = {
      id: "plan-1",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "Verified output",
          id: "inspect",
          status: "pending",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const snapshot = latestRootPlanSnapshot([
      {
        at: "2026-11-09T10:00:00.000Z",
        data: {
          callId: "plan-1",
          capability: { name: "manage_plan" },
          input: { action: "create" },
        },
        index: 0,
        line: 1,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:01.000Z",
        data: {
          callId: "plan-1",
          outcome: "completed",
          output: { plan: initialPlan },
        },
        index: 0,
        line: 2,
        sessionId: "old",
        type: "call.settled",
      },
      {
        at: "2026-11-09T10:00:02.000Z",
        data: {
          callId: "dispatch-1",
          capability: { name: "dispatch_plan_step" },
          input: {
            planId: "plan-1",
            revision: 2,
            stepId: "inspect",
            target: "agent",
          },
        },
        index: 0,
        line: 3,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:03.000Z",
        data: { callId: "dispatch-1", taskId: "outer-task" },
        index: 0,
        line: 4,
        sessionId: "old",
        type: "call.started",
      },
      {
        at: "2026-11-09T10:00:04.000Z",
        data: { callId: "dispatch-1", taskId: "child-task" },
        index: 0,
        line: 5,
        sessionId: "old",
        type: "task.started",
      },
      {
        at: "2026-11-09T10:00:05.000Z",
        data: {
          callId: "cancel-1",
          capability: { name: "manage_plan" },
          input: { action: "update", id: "plan-1" },
        },
        index: 0,
        line: 6,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:06.000Z",
        data: {
          callId: "cancel-1",
          outcome: "completed",
          output: {
            plan: {
              ...initialPlan,
              revision: 4,
              steps: [
                {
                  ...initialPlan.steps[0],
                  note: "Cancelled by the root session.",
                  status: "cancelled",
                },
              ],
            },
          },
        },
        index: 0,
        line: 7,
        sessionId: "old",
        type: "call.settled",
      },
    ]);
    expect(snapshot?.revision).toBe(4);
    expect(snapshot?.steps[0]).toMatchObject({
      note: "Cancelled by the root session.",
      status: "cancelled",
      taskId: "child-task",
    });
  });

  it("does not let a late dispatch result reopen a cancelled step", () => {
    const initialPlan = {
      id: "plan-1",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "Verified output",
          id: "inspect",
          status: "pending",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const cancelledPlan = {
      ...initialPlan,
      revision: 4,
      steps: [
        {
          ...initialPlan.steps[0],
          note: "Cancelled by the root session.",
          status: "cancelled",
        },
      ],
    };
    const latePlan = {
      ...initialPlan,
      revision: 5,
      steps: [
        {
          ...initialPlan.steps[0],
          status: "in_progress",
        },
      ],
    };
    const snapshot = latestRootPlanSnapshot([
      {
        at: "2026-11-09T10:00:00.000Z",
        data: {
          callId: "plan-1",
          capability: { name: "manage_plan" },
          input: { action: "create" },
        },
        index: 0,
        line: 1,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:01.000Z",
        data: {
          callId: "plan-1",
          outcome: "completed",
          output: { plan: initialPlan },
        },
        index: 0,
        line: 2,
        sessionId: "old",
        type: "call.settled",
      },
      {
        at: "2026-11-09T10:00:02.000Z",
        data: {
          callId: "dispatch-1",
          capability: { name: "dispatch_plan_step" },
          input: {
            planId: "plan-1",
            revision: 2,
            stepId: "inspect",
            target: "agent",
          },
        },
        index: 0,
        line: 3,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:03.000Z",
        data: {
          callId: "cancel-1",
          capability: { name: "manage_plan" },
          input: { action: "update", id: "plan-1" },
        },
        index: 0,
        line: 4,
        sessionId: "old",
        type: "call.requested",
      },
      {
        at: "2026-11-09T10:00:04.000Z",
        data: {
          callId: "cancel-1",
          outcome: "completed",
          output: { plan: cancelledPlan },
        },
        index: 0,
        line: 5,
        sessionId: "old",
        type: "call.settled",
      },
      {
        at: "2026-11-09T10:00:05.000Z",
        data: {
          callId: "dispatch-1",
          outcome: "completed",
          output: { plan: latePlan },
        },
        index: 0,
        line: 6,
        sessionId: "old",
        type: "call.settled",
      },
    ]);
    expect(snapshot?.steps[0]).toMatchObject({
      note: "Cancelled by the root session.",
      status: "cancelled",
    });
  });

  it("keeps a valid root plan and partial tool evidence without raw payloads", () => {
    const packet = buildRecoveryPacket(
      [
        {
          at: "2026-11-09T10:00:00.000Z",
          data: {
            callId: "read-1",
            capability: { name: "read_file" },
            input: { filePath: "/data/secret.txt", token: "sk-test-secret" },
          },
          index: 0,
          line: 1,
          sessionId: "old",
          type: "call.requested",
        },
        {
          at: "2026-11-09T10:00:01.000Z",
          data: { callId: "read-1" },
          index: 0,
          line: 2,
          sessionId: "old",
          type: "call.started",
        },
        {
          at: "2026-11-09T10:00:02.000Z",
          data: {
            callId: "read-1",
            outcome: "completed",
            output: { contents: "api_key=do-not-copy" },
          },
          index: 0,
          line: 3,
          sessionId: "old",
          type: "call.settled",
        },
        {
          at: "2026-11-09T10:00:03.000Z",
          data: {
            callId: "plan-1",
            capability: { name: "manage_plan" },
          },
          index: 0,
          line: 4,
          sessionId: "old",
          type: "call.requested",
        },
        {
          at: "2026-11-09T10:00:04.000Z",
          data: {
            callId: "plan-1",
            outcome: "completed",
            output: plan,
          },
          index: 0,
          line: 5,
          sessionId: "old",
          type: "call.settled",
        },
        {
          at: "2026-11-09T10:00:05.000Z",
          data: {
            data: {
              callId: "child-call",
              capability: { name: "write_file" },
            },
            scope: { taskId: "delegated" },
          },
          index: 0,
          line: 6,
          sessionId: "old",
          type: "call.requested",
        },
        {
          at: "2026-11-09T10:00:06.000Z",
          data: { callId: "child-call", taskId: "delegated" },
          index: 0,
          line: 6,
          sessionId: "old",
          type: "call.settled",
        },
      ],
      [
        {
          at: "2026-11-09T09:59:00.000Z",
          id: "message-1",
          role: "user",
          sessionId: "old",
          text: "Continue the contract review.",
        },
      ],
      "old",
      new Date("2026-11-09T10:01:00.000Z")
    );

    expect(packet.plan).toMatchObject({ id: "plan-1", revision: 2 });
    expect(packet.tools).toContainEqual(
      expect.objectContaining({ callId: "read-1", status: "completed" })
    );
    expect(packet.actions.completed).toContain("read-1");
    expect(JSON.stringify(packet)).not.toContain("sk-test-secret");
    expect(JSON.stringify(packet)).not.toContain("do-not-copy");
    expect(JSON.stringify(packet)).not.toContain(
      "never copied into the packet"
    );
    expect(JSON.stringify(packet)).not.toContain("child-call");
    expect(withoutUnprovenPlan(packet).plan).toBeUndefined();
  });

  it("projects the directed full plan into the bounded recovery packet", () => {
    const trustedPlan: TaskPlan = {
      id: "plan-1",
      revision: 9,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          execution: {
            id: "exec-1",
            kind: "agent",
            owner: { sessionId: "old" },
            planRevision: 9,
            status: "blocked",
            taskId: "eve-task-1",
          },
          expectedResult: "must stay private",
          id: "inspect",
          note: "inspect before retrying",
          status: "blocked",
          taskId: "eve-task-1",
          title: "Inspect",
        },
      ],
      title: "Recover",
    };
    const packet = buildRecoveryPacket([], [], "old", new Date(), trustedPlan);
    expect(packet.plan).toEqual({
      id: "plan-1",
      revision: 9,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          id: "inspect",
          status: "blocked",
          taskId: "eve-task-1",
          title: "Inspect",
        },
      ],
      title: "Recover",
    });
    expect(JSON.stringify(packet)).not.toContain("must stay private");
  });

  it("keeps started work explicitly unknown and remains bounded", () => {
    const packet = buildRecoveryPacket(
      Array.from({ length: 3000 }, (_, line) => ({
        at: new Date("2026-11-09T10:00:00.000Z"),
        data: {
          callId: `call-${line}`,
          capability: { name: "tool" },
          input: { secret: "should not be retained" },
        },
        index: 0,
        line,
        sessionId: "old",
        type: "call.requested",
      })),
      [],
      "old"
    );
    expect(packet.tools.length).toBeLessThanOrEqual(48);
    expect(packet.history.eventIds.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(packet).length).toBeLessThan(18_000);
    expect(packet.actions.unknown.length).toBeGreaterThan(0);
  });

  it("enforces the recovery bound in UTF-8 bytes across action metadata", () => {
    const rows = Array.from({ length: 48 }, (_, index) => {
      const callId = `${index}-é`.padEnd(200, "界");
      return [
        {
          at: new Date("2026-11-09T10:00:00.000Z"),
          data: {
            callId,
            capability: { name: "read_file" },
          },
          index: 0,
          line: index * 2,
          sessionId: "old",
          type: "call.requested",
        },
        {
          at: new Date("2026-11-09T10:00:00.000Z"),
          data: { callId, outcome: "completed" },
          index: 0,
          line: index * 2 + 1,
          sessionId: "old",
          type: "call.settled",
        },
      ];
    }).flat();
    const packet = buildRecoveryPacket(rows, [], "old");
    expect(
      new TextEncoder().encode(JSON.stringify(packet)).byteLength
    ).toBeLessThanOrEqual(18_000);
  });
});
