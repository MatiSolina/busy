import { describe, expect, it } from "vitest";
import { type PlanStep, parseTaskPlan } from "./task-plan";
import { planStepsSchema, taskPlanSchema } from "./task-plan-schema";

const step = (id: string, patch: Partial<PlanStep> = {}): PlanStep => ({
  assignee: "self",
  dependsOn: [],
  expectedResult: "A verified result",
  id,
  status: "pending",
  title: id,
  ...patch,
});

describe("task plan dependencies and evidence", () => {
  it.each([
    "pending",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
  ] as const)(
    "replays the bot's validated %s result without its runtime dependencies",
    (status) => {
      const plan = taskPlanSchema.parse({
        id: "plan-1",
        revision: 1,
        steps: [step("result", { note: "Result or blocker checked", status })],
        title: "Task",
      });
      expect(parseTaskPlan({ plan })).toEqual(plan);
    }
  );

  it("allows independent work in parallel and a dependent step after completion", () => {
    expect(
      planStepsSchema.safeParse([
        step("research", { note: "Sources checked", status: "completed" }),
        step("analysis", { status: "in_progress" }),
        step("write", { dependsOn: ["research"], status: "in_progress" }),
      ]).success
    ).toBe(true);
  });

  it.each([
    [step("a"), step("a")],
    [step("a", { dependsOn: ["missing"] })],
    [step("a", { dependsOn: ["a"] })],
    [step("a"), step("b", { dependsOn: ["a", "a"] })],
    [step("a", { dependsOn: ["b"] }), step("b", { dependsOn: ["a"] })],
    [
      step("a", { dependsOn: ["b"] }),
      step("b", { dependsOn: ["c"] }),
      step("c", { dependsOn: ["a"] }),
    ],
    [step("a"), step("b", { dependsOn: ["a"], status: "in_progress" })],
    [
      step("a"),
      step("b", { dependsOn: ["a"], note: "Done", status: "completed" }),
    ],
    [step("a", { status: "completed" })],
    [step("a", { status: "blocked" })],
    [],
    Array.from({ length: 21 }, (_, index) => step(`step-${index}`)),
  ])("rejects invalid graph or unsupported progress: %j", (...steps) => {
    expect(planStepsSchema.safeParse(steps).success).toBe(false);
  });

  it("requires blocker details but allows blocked work to wait on dependencies", () => {
    expect(
      planStepsSchema.safeParse([
        step("source"),
        step("review", {
          dependsOn: ["source"],
          note: "Waiting for the source document",
          status: "blocked",
        }),
      ]).success
    ).toBe(true);
  });

  it("rejects a claimed delegated completion before settlement evidence", () => {
    expect(
      planStepsSchema.safeParse([
        step("delegated", {
          execution: {
            id: "exec-1",
            kind: "agent",
            owner: { sessionId: "root" },
            planRevision: 2,
            status: "running",
            taskId: "task-1",
          },
          note: "The model says it is done",
          status: "completed",
          taskId: "task-1",
        }),
      ]).success
    ).toBe(false);
  });

  it("rejects invalid stream output instead of treating arbitrary objects as plans", () => {
    const plan = {
      id: "plan-1",
      revision: 1,
      steps: [step("a")],
      title: "Task",
    };
    expect(parseTaskPlan({ plan })).toEqual(plan);
    expect(parseTaskPlan({ plan: { ...plan, revision: 0 } })).toBeNull();
    expect(
      parseTaskPlan({
        plan: { ...plan, steps: [step("a", { status: "completed" })] },
      })
    ).toBeNull();
    expect(parseTaskPlan(plan)).toBeNull();
    expect(parseTaskPlan({ plan: null })).toBeNull();
  });

  it("accepts only a bounded server dispatch count", () => {
    const valid = taskPlanSchema.parse({
      dispatchCount: 20,
      id: "plan-1",
      revision: 1,
      steps: [step("a")],
      title: "Task",
    });
    expect(parseTaskPlan({ plan: valid })).toEqual(valid);
    for (const dispatchCount of [-1, 21, 1.5, "20"]) {
      expect(
        taskPlanSchema.safeParse({
          dispatchCount,
          id: "plan-1",
          revision: 1,
          steps: [step("a")],
          title: "Task",
        }).success
      ).toBe(false);
    }
  });
});
