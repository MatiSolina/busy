import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import cancel from "./cancel_code_task";
import get from "./get_code_task";
import start from "./start_code_task";
import update from "./update_code_task";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);
vi.mock("../lib/hub", () => ({ hubFetch }));

const CODE_TASK_ID = /^[0-9a-f-]{36}$/u;

interface Tool {
  execute: (
    input: Record<string, unknown>,
    ctx: ReturnType<typeof context>
  ) => Promise<Record<string, unknown>>;
  inputSchema: { safeParse: (value: unknown) => { success: boolean } };
}

const resolver = (value: unknown) => {
  const symbol = Object.getOwnPropertySymbols(value).at(0);
  if (symbol === undefined) {
    throw new Error("dynamic tool has no resolver");
  }
  const resolve = (value as Record<symbol, (ctx: unknown) => Tool | null>)[
    symbol
  ];
  if (resolve === undefined) {
    throw new Error("dynamic tool resolver is missing");
  }
  return resolve;
};
const context = (
  principalId = "owner:team:project:busy:environment:production",
  principalType = "app",
  callId = "call-1"
) => ({
  abortSignal: new AbortController().signal,
  callId,
  session: {
    auth: { current: { principalId, principalType } },
    id: "session-1",
  },
});

const toolFor = (value: unknown, ctx = context()) => {
  const tool = resolver(value)(ctx);
  if (tool === null) {
    throw new Error("tool unexpectedly unavailable");
  }
  return tool;
};
const startTool = () => toolFor(start);
const getTool = () => toolFor(get);
const updateTool = () => toolFor(update);
const cancelTool = () => toolFor(cancel);

beforeEach(() =>
  hubFetch
    .mockReset()
    .mockResolvedValue(
      Response.json({ task: { id: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" } })
    )
);
afterEach(() => vi.restoreAllMocks());

describe("code task tools", () => {
  it("validates the start input and sends one idempotent request with source context", async () => {
    expect(
      startTool().inputSchema.safeParse({
        goal: "Fix the login bug",
        title: "Fix login",
      }).success
    ).toBe(true);
    expect(
      startTool().inputSchema.safeParse({ goal: "Fix", title: "" }).success
    ).toBe(false);
    await startTool().execute(
      {
        goal: "Fix the login bug",
        repositoryId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
        title: "Fix login",
      },
      context()
    );
    const firstCall = hubFetch.mock.calls.at(0);
    if (firstCall === undefined) {
      throw new Error("start request was not sent");
    }
    const [path, init] = firstCall;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(path).toBe("/api/bot/code-tasks");
    expect(body).toMatchObject({
      goal: "Fix the login bug",
      sourceCallId: "call-1",
      sourceSessionId: "session-1",
      title: "Fix login",
    });
    expect(body.id).toMatch(CODE_TASK_ID);
  });

  it("reads without steering and updates/cancels through command routes", async () => {
    await getTool().execute({}, context());
    await getTool().execute(
      { taskId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" },
      context()
    );
    await updateTool().execute(
      {
        taskId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
        text: "Also cover the error state.",
      },
      context()
    );
    await cancelTool().execute(
      { taskId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a" },
      context()
    );
    expect(
      hubFetch.mock.calls.map(([path, init]) => [path, init?.method])
    ).toEqual([
      ["/api/bot/code-tasks", undefined],
      ["/api/bot/code-tasks/8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a", undefined],
      [
        "/api/bot/code-tasks/8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a/commands",
        "POST",
      ],
      [
        "/api/bot/code-tasks/8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a/commands",
        "POST",
      ],
    ]);
    expect(JSON.parse(String(hubFetch.mock.calls[2]?.[1]?.body))).toMatchObject(
      {
        kind: "steer",
        sourceCallId: "call-1",
        sourceSessionId: "session-1",
        text: "Also cover the error state.",
      }
    );
    expect(JSON.parse(String(hubFetch.mock.calls[3]?.[1]?.body))).toMatchObject(
      {
        kind: "cancel",
        sourceCallId: "call-1",
        sourceSessionId: "session-1",
      }
    );
  });

  it.each([
    [
      "consultation",
      "owner:team:project:bot-lawyer:environment:production",
      "app",
    ],
    [
      "scheduled execution",
      "busy-hub:hub:routine:8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
      "service",
    ],
    [
      "completion",
      "busy-hub:hub:code-task:8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
      "service",
    ],
  ])("is unavailable during %s", (_, principalId, principalType) => {
    const ctx = context(principalId, principalType);
    expect(resolver(start)(ctx)).toBeNull();
    expect(resolver(get)(ctx)).toBeNull();
    expect(resolver(update)(ctx)).toBeNull();
    expect(resolver(cancel)(ctx)).toBeNull();
  });
});
