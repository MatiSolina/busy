import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deployBot: vi.fn(),
  deployTargetOf: vi.fn(),
  refreshBot: vi.fn(),
  sleep: vi.fn(() => Promise.resolve()),
}));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("./lib/bots/service", () => ({
  deployBot: mocks.deployBot,
  deployTargetOf: mocks.deployTargetOf,
  refreshBot: mocks.refreshBot,
}));

const { deployBotWorkflow } = await import("./workflows/deploy-bot");

const target = { botId: "bot-1", generation: 4 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sleep.mockResolvedValue(undefined);
  mocks.deployTargetOf.mockImplementation((arg: unknown) =>
    Promise.resolve(
      typeof arg === "string" ? target : { botId: "bot-1", generation: 4 }
    )
  );
  mocks.deployBot.mockResolvedValue("started");
});

describe("deployBotWorkflow", () => {
  it("builds the generation it was given and polls it until done", async () => {
    mocks.refreshBot
      .mockResolvedValueOnce("continue")
      .mockResolvedValueOnce("done");
    await deployBotWorkflow({ ...target, v: 2 });
    expect(mocks.deployBot).toHaveBeenCalledWith(target);
    expect(mocks.refreshBot).toHaveBeenCalledTimes(2);
    expect(mocks.refreshBot).toHaveBeenCalledWith(target);
  });

  it("accepts the v1 slug argument of runs started before generations", async () => {
    mocks.refreshBot.mockResolvedValue("done");
    await deployBotWorkflow("ana");
    expect(mocks.deployTargetOf).toHaveBeenCalledWith("ana");
    expect(mocks.deployBot).toHaveBeenCalledWith(target);
  });

  it("stops at once when its generation is stale or its row is gone", async () => {
    mocks.deployBot.mockResolvedValue("stale");
    await deployBotWorkflow({ ...target, v: 2 });
    expect(mocks.refreshBot).not.toHaveBeenCalled();
    mocks.deployTargetOf.mockResolvedValue(null);
    await deployBotWorkflow("gone");
    expect(mocks.deployBot).toHaveBeenCalledTimes(1);
  });

  it("treats an ambiguous check as 'check again', never as a failure", async () => {
    mocks.refreshBot
      .mockRejectedValueOnce(new Error("Vercel 502"))
      .mockResolvedValueOnce("done");
    await expect(deployBotWorkflow({ ...target, v: 2 })).resolves.toBe(
      undefined
    );
    expect(mocks.refreshBot).toHaveBeenCalledTimes(2);
  });

  it("is bounded even if a check never says done", async () => {
    mocks.refreshBot.mockResolvedValue("continue");
    await deployBotWorkflow({ ...target, v: 2 });
    expect(mocks.refreshBot).toHaveBeenCalledTimes(240);
  });
});
