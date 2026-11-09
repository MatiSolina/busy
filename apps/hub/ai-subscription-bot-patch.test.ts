import { beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH } from "./app/api/bots/[slug]/route";

const mocks = vi.hoisted(() => ({
  assertModel: vi.fn(),
  getBot: vi.fn(),
  markDeployStartFailed: vi.fn(),
  patchBot: vi.fn(),
  start: vi.fn(),
  Unavailable: class AiProviderUnavailableError extends Error {},
}));

vi.mock("@/lib/ai/settings", () => ({
  AiProviderUnavailableError: mocks.Unavailable,
  assertSubscriptionModelAvailable: mocks.assertModel,
}));
vi.mock("@/lib/bots/service", () => ({
  billingFits: () => true,
  botPatch: { safeParse: (data: unknown) => ({ data, success: true }) },
  DeployRetryConflictError: class DeployRetryConflictError extends Error {},
  deployRunArg: (b: { deployGeneration: number; id: string }) => ({
    botId: b.id,
    generation: b.deployGeneration,
    v: 2,
  }),
  getBot: mocks.getBot,
  markDeployStartFailed: mocks.markDeployStartFailed,
  patchBot: mocks.patchBot,
  publicBot: (value: unknown) => value,
}));
vi.mock("@/lib/bots/deletion", () => ({ requestBotDeletion: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/lib/live", () => ({ stopComputer: vi.fn() }));
vi.mock("@/workflows/deploy-bot", () => ({ deployBotWorkflow: "deploy" }));
vi.mock("@/workflows/delete-bot", () => ({ deleteBotWorkflow: "delete" }));

const bot = {
  billing: "chatgpt",
  deployGeneration: 3,
  id: "bot-1",
  model: "chatgpt/gpt-6.1-sol",
  slug: "legal",
  status: "failed",
};
const context = { params: Promise.resolve({ slug: "legal" }) };
const request = (body: unknown) =>
  new Request("https://busy.test/api/bots/legal", {
    body: JSON.stringify(body),
    method: "PATCH",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockResolvedValue(bot);
  mocks.assertModel.mockResolvedValue(undefined);
  mocks.patchBot.mockResolvedValue({ bot, redeploy: true });
});

describe("subscription bot edits", () => {
  it("rejects a model outside the account catalog before saving or deploying", async () => {
    mocks.assertModel.mockRejectedValue(
      new mocks.Unavailable("Choose an available model.")
    );
    const response = await PATCH(
      request({ model: "chatgpt/fake-model" }),
      context
    );
    expect(response.status).toBe(409);
    expect(mocks.patchBot).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("checks the combined provider and model before a subscription switch", async () => {
    const response = await PATCH(
      request({ billing: "grok", model: "grok/grok-4.7" }),
      context
    );
    expect(response.status).toBe(200);
    expect(mocks.assertModel).toHaveBeenCalledWith("grok", "grok/grok-4.7");
    expect(mocks.patchBot).toHaveBeenCalledOnce();
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("allows a rename without needing to reconnect or redeploy", async () => {
    mocks.patchBot.mockResolvedValue({
      bot: { ...bot, name: "New name" },
      redeploy: false,
    });
    const response = await PATCH(request({ name: "New name" }), context);
    expect(response.status).toBe(200);
    expect(mocks.assertModel).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
  });
});

describe("deploy retries and start failures", () => {
  it("passes an explicit retry and starts the new generation", async () => {
    const response = await PATCH(request({ retry: true }), context);
    expect(response.status).toBe(200);
    expect(mocks.patchBot).toHaveBeenCalledWith(
      bot,
      { retry: true },
      {
        retry: true,
      }
    );
    expect(mocks.start).toHaveBeenCalledWith("deploy", [
      { botId: "bot-1", generation: 3, v: 2 },
    ]);
  });

  it("answers 409 to a retry of a bot that isn't creating or failed", async () => {
    const { DeployRetryConflictError } = await import("@/lib/bots/service");
    mocks.patchBot.mockRejectedValue(new DeployRetryConflictError());
    const response = await PATCH(request({ retry: true }), context);
    expect(response.status).toBe(409);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("marks the new generation failed when its workflow cannot start", async () => {
    mocks.start.mockRejectedValue(new Error("queue down"));
    mocks.markDeployStartFailed.mockResolvedValue({ ...bot, status: "failed" });
    const response = await PATCH(request({ instructions: "v2" }), context);
    expect(response.status).toBe(200);
    expect(mocks.markDeployStartFailed).toHaveBeenCalledWith(bot);
  });
});
