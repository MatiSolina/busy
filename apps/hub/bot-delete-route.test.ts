import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE } from "./app/api/bots/[slug]/route";

const mocks = vi.hoisted(() => ({
  getBot: vi.fn(),
  requestBotDeletion: vi.fn(),
  start: vi.fn(),
  stopComputerObserved: vi.fn(),
}));

vi.mock("@/lib/ai/settings", () => ({
  AiProviderUnavailableError: class extends Error {},
  assertSubscriptionModelAvailable: vi.fn(),
}));
vi.mock("@/lib/bots/service", () => ({
  billingFits: () => true,
  botPatch: { safeParse: vi.fn() },
  botProgress: vi.fn(),
  getBot: mocks.getBot,
  patchBot: vi.fn(),
  publicBot: (value: unknown) => value,
}));
vi.mock("@/lib/bots/deletion", () => ({
  requestBotDeletion: mocks.requestBotDeletion,
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/live", () => ({
  stopComputerObserved: mocks.stopComputerObserved,
}));
vi.mock("@/workflows/deploy-bot", () => ({ deployBotWorkflow: "deploy" }));
vi.mock("@/workflows/delete-bot", () => ({ deleteBotWorkflow: "delete" }));

const bot = { id: "11111111-1111-4111-8111-111111111111", slug: "legal" };
const context = () => ({ params: Promise.resolve({ slug: bot.slug }) });
const request = () =>
  new Request("https://busy.test/api/bots/legal", { method: "DELETE" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockResolvedValue(bot);
  mocks.stopComputerObserved.mockResolvedValue(undefined);
  mocks.start.mockResolvedValue({ runId: "run" });
});

describe("DELETE /api/bots/[slug]", () => {
  it("marks the bot deleting before starting the workflow and accepts durably", async () => {
    mocks.requestBotDeletion.mockResolvedValue({ start: true, token: "t1" });
    const response = await DELETE(request(), context());
    expect(response.status).toBe(202);
    expect(mocks.requestBotDeletion).toHaveBeenCalledWith(bot.id);
    expect(mocks.start).toHaveBeenCalledWith("delete", [bot.id, "t1"]);
    expect(
      mocks.requestBotDeletion.mock.invocationCallOrder[0] ?? 0
    ).toBeLessThan(mocks.start.mock.invocationCallOrder[0] ?? 0);
  });

  it("still accepts when the workflow cannot start: the cron restarts it from the row", async () => {
    mocks.requestBotDeletion.mockResolvedValue({ start: true, token: "t1" });
    mocks.start.mockRejectedValue(new Error("queue unavailable"));
    expect((await DELETE(request(), context())).status).toBe(202);
  });

  it("does not start a second run while one holds the deletion", async () => {
    mocks.requestBotDeletion.mockResolvedValue({ start: false, token: "t1" });
    expect((await DELETE(request(), context())).status).toBe(202);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("answers 404 for a bot that is already gone", async () => {
    mocks.getBot.mockResolvedValue(undefined);
    expect((await DELETE(request(), context())).status).toBe(404);
    mocks.getBot.mockResolvedValue(bot);
    mocks.requestBotDeletion.mockResolvedValue(null);
    expect((await DELETE(request(), context())).status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
  });
});
