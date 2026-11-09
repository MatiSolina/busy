import { beforeEach, describe, expect, it, vi } from "vitest";
import { notifyCodeResult } from "./notify";

const mocks = vi.hoisted(() => ({
  appendEvent: vi.fn(),
  db: vi.fn(),
  getTaskRow: vi.fn(),
  patchRuntimeExecution: vi.fn(),
  sendMessage: vi.fn(),
  signCodeTaskToken: vi.fn(),
  syncBot: vi.fn(),
}));

vi.mock("@/lib/code-tasks/store", () => ({
  appendEvent: mocks.appendEvent,
  getTaskRow: mocks.getTaskRow,
  patchRuntimeExecution: mocks.patchRuntimeExecution,
}));
vi.mock("@/lib/chat/store", () => ({ syncBot: mocks.syncBot }));
vi.mock("@/lib/db", async () => {
  const schema =
    await vi.importActual<typeof import("@/lib/db/schema")>("@/lib/db/schema");
  return { bots: { id: "id" }, codeTasks: schema.codeTasks, db: mocks.db };
});
vi.mock("@/lib/eve/client", () => ({ sendMessage: mocks.sendMessage }));
vi.mock("@/lib/hub-token", () => ({
  signCodeTaskToken: mocks.signCodeTaskToken,
}));

const task = {
  botId: "11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-11-02T00:00:00Z"),
  error: null,
  execution: {},
  id: "55555555-5555-4555-8555-555555555555",
  instructionVersion: 2,
  pullRequestUrl: "https://github.com/acme/widgets/pull/3",
  repositoryFullName: "acme/widgets",
  revision: 1,
  sourceSessionId: "main-session",
  status: "ready",
  summary: "The change is ready.",
  title: "Fix login",
  version: 4,
};
const bot = {
  id: task.botId,
  sessionId: task.sourceSessionId,
  slug: "main",
  url: "https://main.bots.test",
};

function dbBotQuery() {
  return {
    from: () => ({
      where: () => ({ limit: async () => [bot] }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.db.mockReturnValue({ select: dbBotQuery });
  mocks.getTaskRow.mockResolvedValue(task);
  mocks.sendMessage.mockResolvedValue({ deliveryId: "delivery-1" });
  mocks.signCodeTaskToken.mockReturnValue("signed-code-task-token");
  mocks.patchRuntimeExecution.mockResolvedValue({ id: task.id });
  mocks.appendEvent.mockResolvedValue(undefined);
  mocks.syncBot.mockResolvedValue(undefined);
});

describe("code-task result notification", () => {
  it("pins the originating session and uses a scoped service token", async () => {
    await notifyCodeResult(task.id);
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        token: expect.any(Function),
        url: bot.url,
      }),
      task.sourceSessionId,
      expect.objectContaining({
        id: expect.any(String),
        text: expect.stringContaining("<code_task_result>"),
        turnPolicy: "queue",
      })
    );
    const call = mocks.sendMessage.mock.calls.at(0)?.[0] as
      | { token: () => string }
      | undefined;
    if (call === undefined) {
      throw new Error("notification call was not sent");
    }
    expect(call.token()).toBe("signed-code-task-token");
    expect(mocks.signCodeTaskToken).toHaveBeenCalledWith(bot.slug, task.id);
    expect(mocks.patchRuntimeExecution).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        notification: expect.objectContaining({
          key: `${task.revision}:${task.instructionVersion}:ready`,
          outcome: "sent",
        }),
        notificationInstructionVersion: task.instructionVersion,
        notificationSkipped: false,
      }),
      expect.anything()
    );
  });

  it("does not send when the bot's main session has been replaced", async () => {
    mocks.db.mockReturnValue({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ ...bot, sessionId: "replacement-session" }],
          }),
        }),
      }),
    });
    await notifyCodeResult(task.id);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.patchRuntimeExecution).toHaveBeenCalledWith(
      task.id,
      expect.objectContaining({
        notification: expect.objectContaining({
          outcome: "skipped",
          reason: "source session unavailable",
        }),
        notificationSkipped: true,
      }),
      expect.anything()
    );
  });

  it("is idempotent when the same revision was already delivered", async () => {
    await notifyCodeResult(task.id);
    const updateCall = mocks.patchRuntimeExecution.mock.calls.at(0);
    if (updateCall === undefined) {
      throw new Error("notification state was not persisted");
    }
    const recorded = updateCall[1] as Record<string, unknown>;
    task.execution = recorded;
    await notifyCodeResult(task.id);
    task.execution = {};
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.patchRuntimeExecution).toHaveBeenCalledTimes(1);
  });
});
