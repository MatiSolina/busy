import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { planExecutionBudget } from "../lib/plan-state";
import type { TaskPlan } from "../lib/task-plan";
import { defined } from "../test-utils";
import dynamic from "./manage_plan";

// Model Eve's checkpoint store, separate from module lifetime and scoped by session.
const durable = vi.hoisted(() => ({
  session: "session-1",
  values: new Map<string, unknown>(),
}));
vi.mock("eve/context", () => ({
  defineState: (name: string, initial: () => unknown) => ({
    get: () => durable.values.get(`${durable.session}:${name}`) ?? initial(),
    update: (fn: (value: unknown) => unknown) => {
      const key = `${durable.session}:${name}`;
      durable.values.set(key, fn(durable.values.get(key) ?? initial()));
    },
  }),
}));

interface Tool {
  availableInSubagents: boolean;
  execute: (input: unknown, ctx: unknown) => { plan: TaskPlan | null };
  inputSchema: z.ZodType;
}

function resolve(definition: unknown, ctx: unknown): Tool | null {
  const dynamicDefinition = definition as Record<
    symbol,
    (context: unknown) => Tool | null
  >;
  return defined(
    dynamicDefinition[defined(Object.getOwnPropertySymbols(definition)[0])]
  )(ctx);
}

const context = (id = "session-1", callId = "call-1") => ({
  callId,
  session: {
    auth: {
      current: { principalId: "busy-hub:hub", principalType: "service" },
    },
    id,
  },
});

const steps = [
  {
    assignee: "self",
    dependsOn: [],
    expectedResult: "Dated sources",
    id: "research",
    status: "pending",
    title: "Research",
  },
  {
    assignee: "agent",
    dependsOn: ["research"],
    expectedResult: "Verified proposal",
    id: "write",
    status: "pending",
    title: "Write proposal",
  },
];

function execute(input: unknown, ctx = context(), definition = dynamic) {
  durable.session = ctx.session.id;
  return defined(resolve(definition, ctx)).execute(input, ctx);
}

const create = () =>
  defined(execute({ action: "create", steps, title: "Proposal" }).plan);

beforeEach(() => {
  durable.session = "session-1";
  durable.values.clear();
});

describe("manage_plan durable lifecycle", () => {
  it("creates idempotently and refuses to overwrite an unfinished plan", () => {
    const first = create();
    planExecutionBudget.update(() => ({
      activeExecutionIds: ["exec-running"],
      dispatchesThisTurn: 3,
      planId: first.id,
      totalDispatches: 4,
      turnId: "turn-1",
    }));
    expect(create()).toEqual(first);
    expect(planExecutionBudget.get()).toMatchObject({
      activeExecutionIds: ["exec-running"],
      dispatchesThisTurn: 3,
      planId: first.id,
      totalDispatches: 4,
      turnId: "turn-1",
    });
    expect(() =>
      execute(
        { action: "create", steps, title: "Other work" },
        context("session-1", "call-2")
      )
    ).toThrow("active plan");
    expect(execute({ action: "get" }).plan).toEqual(first);
  });

  it("retains state through module reloads and isolates a different session", async () => {
    const first = create();
    vi.resetModules();
    const { default: reloaded } = await import("./manage_plan");
    expect(execute({ action: "get" }, context(), reloaded).plan).toEqual(first);
    expect(
      execute({ action: "get" }, context("session-2"), reloaded).plan
    ).toBeNull();
    expect(execute({ action: "get" }, context(), reloaded).plan).toEqual(first);
  });

  it("tracks delegated task ids, rejects stale progress, and protects dependency order", () => {
    const plan = create();
    expect(() =>
      execute({
        action: "update",
        id: plan.id,
        revision: 1,
        steps: [steps[0], { ...steps[1], status: "in_progress" }],
      })
    ).toThrow("dependencies");
    const updated = execute({
      action: "update",
      id: plan.id,
      revision: 1,
      steps: [
        { ...steps[0], note: "Sources inspected", status: "completed" },
        { ...steps[1], status: "in_progress", taskId: "task-writer" },
      ],
    });
    expect(updated.plan).toMatchObject({
      revision: 2,
      steps: [
        { id: "research", status: "completed" },
        { id: "write", taskId: "task-writer" },
      ],
    });
    expect(() =>
      execute({ action: "update", id: plan.id, revision: 1, steps })
    ).toThrow("revision changed");
    expect(() =>
      execute({
        action: "cancel",
        id: "another-plan",
        reason: "Cancel",
        revision: 2,
      })
    ).toThrow("not found");
    expect(execute({ action: "get" })).toEqual(updated);
  });

  it("preserves completed work on cancellation and permits the next plan", () => {
    const plan = create();
    execute({
      action: "update",
      id: plan.id,
      revision: 1,
      steps: [
        { ...steps[0], note: "Source checked", status: "completed" },
        steps[1],
      ],
    });
    const cancelled = execute({
      action: "cancel",
      id: plan.id,
      reason: "The user changed the objective",
      revision: 2,
    });
    expect(cancelled.plan?.steps.map(({ status }) => status)).toEqual([
      "completed",
      "cancelled",
    ]);
    const next = execute(
      { action: "create", steps, title: "New objective" },
      context("session-1", "call-new")
    );
    expect(next.plan?.id).not.toBe(plan.id);
    expect(next.plan?.revision).toBe(1);
  });

  it("completes a plan only with evidence for all results", () => {
    const plan = create();
    const done = steps.map((step) => ({
      ...step,
      note: "File inspected and delivered",
      status: "completed",
    }));
    expect(
      execute({
        action: "update",
        id: plan.id,
        revision: 1,
        steps: done,
      }).plan?.steps.every((step) => step.status === "completed")
    ).toBe(true);
    expect(
      execute(
        { action: "create", steps, title: "Next task" },
        context("session-1", "call-next")
      ).plan?.title
    ).toBe("Next task");
  });
});

describe("manage_plan authorization and provider schema", () => {
  it.each([
    "owner:t:project:bot-lawyer:environment:production",
    "busy-hub:hub:routine:123",
    "busy-hub:hub:code-task:123",
  ])("hides and rejects a stale offered call for %s", (principalId) => {
    const offered = defined(resolve(dynamic, context()));
    const ctx = context();
    ctx.session.auth.current.principalId = principalId;
    expect(resolve(dynamic, ctx)).toBeNull();
    expect(() => offered.execute({ action: "get" }, ctx)).toThrow(
      "root session"
    );
    expect(durable.values.size).toBe(0);
  });

  it("keeps the plan root-owned even when a child inherits the authored tools", () => {
    const ctx = {
      ...context(),
      session: { ...context().session, parent: { sessionId: "parent" } },
    };
    const offered = defined(resolve(dynamic, context()));
    expect(offered.availableInSubagents).toBe(false);
    expect(resolve(dynamic, ctx)).toBeNull();
    expect(() =>
      offered.execute(
        { action: "create", steps, title: "Child overwrite" },
        ctx
      )
    ).toThrow("root session");
  });

  it("publishes an object schema and rejects ambiguous action fields", () => {
    const tool = defined(resolve(dynamic, context()));
    const schema = z.toJSONSchema(tool.inputSchema) as {
      type: string;
      anyOf?: unknown;
    };
    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    for (const input of [
      { action: "create", title: "Missing steps" },
      { action: "get", title: "Unexpected field" },
      { action: "update", steps },
      { action: "get", sessionId: "another-session" },
    ]) {
      expect(tool.inputSchema.safeParse(input).success).toBe(false);
    }
  });

  it("recalls active progress as user data without requiring a mode or resuming unrelated work", async () => {
    create();
    const { default: instructions } = await import("../instructions/plan");
    const recall = resolve(instructions, context()) as unknown as {
      content: string;
      role: string;
    };
    expect(recall.role).toBe("user");
    expect(recall.content).toContain('"taskPlan"');
    expect(recall.content).toContain("do not resume unrelated work");
    expect(
      resolve(instructions, {
        ...context(),
        session: { ...context().session, parent: {} },
      })
    ).toBeNull();
  });
});
