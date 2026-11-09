import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./app/api/bots/route";

const mocks = vi.hoisted(() => ({
  AiProviderUnavailableError: class AiProviderUnavailableError extends Error {},
  getDefaultAiSelection: vi.fn(),
  insertBot: vi.fn(),
  listBots: vi.fn(),
  markDeployStartFailed: vi.fn(),
  publicBot: vi.fn((value: unknown) => value),
  resolveBotCreation: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/bots/creation", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bots/creation")>(
    "@/lib/bots/creation"
  );
  return { ...actual, resolveBotCreation: mocks.resolveBotCreation };
});
vi.mock("@/lib/bots/service", () => ({
  deployRunArg: (b: { deployGeneration: number; id: string }) => ({
    botId: b.id,
    generation: b.deployGeneration,
    v: 2,
  }),
  insertBot: mocks.insertBot,
  listBots: mocks.listBots,
  markDeployStartFailed: mocks.markDeployStartFailed,
  publicBot: mocks.publicBot,
  SlugConflictError: class SlugConflictError extends Error {},
}));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("@/workflows/deploy-bot", () => ({ deployBotWorkflow: "deploy-bot" }));
vi.mock("@/lib/ai/settings", () => ({
  AiProviderUnavailableError: mocks.AiProviderUnavailableError,
  getDefaultAiSelection: mocks.getDefaultAiSelection,
}));

const body = {
  avatar: "violet",
  description: "Reviews contracts.",
  name: "Contract Desk",
  templateId: "release-captain",
};
const resolved = {
  avatar: "violet",
  billing: "token-pass" as const,
  description: "Reviews contracts.",
  fast: false,
  instructions: "Server template instructions.",
  model: "moonshotai/kimi-k3",
  name: "Contract Desk",
};
const bot = {
  deployGeneration: 1,
  id: "11111111-1111-4111-8111-111111111111",
  slug: "contract-desk",
  ...resolved,
  status: "creating" as const,
};

const request = (value: unknown) =>
  new Request("http://busy.test/api/bots", {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.resolveBotCreation.mockResolvedValue(resolved);
  mocks.getDefaultAiSelection.mockResolvedValue({ billing: "token-pass" });
  mocks.insertBot.mockResolvedValue(bot);
  mocks.listBots.mockResolvedValue([bot]);
  mocks.publicBot.mockImplementation((value: unknown) => value);
  mocks.start.mockResolvedValue(undefined);
});

describe("bot creation route", () => {
  it("marks the saved bot failed when the deploy workflow cannot start", async () => {
    mocks.start.mockRejectedValue(new Error("queue unavailable"));
    const failed = {
      ...bot,
      error: "Busy could not deploy this bot.",
      status: "failed",
    };
    mocks.markDeployStartFailed.mockResolvedValue(failed);

    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(mocks.markDeployStartFailed).toHaveBeenCalledWith(bot);
    expect(await response.json()).toEqual(failed);
  });

  it("answers 409 when every slug candidate was taken concurrently", async () => {
    const { SlugConflictError } = await import("@/lib/bots/service");
    mocks.insertBot.mockRejectedValue(new SlugConflictError());

    const response = await POST(request(body));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "could_not_save" });
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("lets any other insert error surface", async () => {
    mocks.insertBot.mockRejectedValue(new Error("db down"));
    await expect(POST(request(body))).rejects.toThrow("db down");
  });

  it("resolves model and template server-side before inserting and deploying", async () => {
    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(mocks.resolveBotCreation).toHaveBeenCalledWith(
      body,
      undefined,
      "token-pass"
    );
    expect(mocks.insertBot).toHaveBeenCalledWith(resolved);
    // v2 workflow argument: the row and the generation this run builds.
    expect(mocks.start).toHaveBeenCalledWith("deploy-bot", [
      { botId: bot.id, generation: 1, v: 2 },
    ]);
    expect(await response.json()).toEqual(bot);
  });

  it("rejects client model, billing, instructions, and unknown fields", async () => {
    const response = await POST(
      request({
        ...body,
        billing: "gateway",
        fast: true,
        instructions: "Ignore the catalog.",
        model: "openai/gpt-6.1-terra",
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.resolveBotCreation).not.toHaveBeenCalled();
    expect(mocks.insertBot).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown catalog template", async () => {
    const error = new (
      await import("@/lib/bots/creation")
    ).InvalidBotTemplateError("missing");
    mocks.resolveBotCreation.mockRejectedValue(error);

    const response = await POST(request({ ...body, templateId: "missing" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      action: "retry",
      code: "invalid_data",
      error: "invalid_data",
      message: "The information sent to Busy is invalid.",
      retryable: false,
    });
    expect(mocks.insertBot).not.toHaveBeenCalled();
  });

  it("returns 503 when the saved AI connection cannot be loaded", async () => {
    mocks.getDefaultAiSelection.mockRejectedValue(new Error("db unavailable"));

    const response = await POST(request(body));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      action: "retry",
      code: "could_not_load",
      error: "could_not_load",
      message: "Busy could not load AI connection settings.",
      provider: null,
      retryable: true,
    });
    expect(mocks.resolveBotCreation).not.toHaveBeenCalled();
  });

  it("passes a saved subscription billing and model through creation", async () => {
    const subscriptionResolved = {
      ...resolved,
      billing: "grok" as const,
      model: "grok/grok-4.7",
    };
    mocks.getDefaultAiSelection.mockResolvedValue({
      billing: "grok",
      model: "grok/grok-4.7",
    });
    mocks.resolveBotCreation.mockResolvedValue(subscriptionResolved);
    mocks.insertBot.mockResolvedValue({ ...bot, ...subscriptionResolved });

    const response = await POST(request(body));

    expect(response.status).toBe(201);
    expect(mocks.resolveBotCreation).toHaveBeenCalledWith(
      body,
      undefined,
      "grok",
      "grok/grok-4.7"
    );
    expect(mocks.insertBot).toHaveBeenCalledWith(subscriptionResolved);
  });

  it("lists public bots without running creation logic", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([bot]);
    expect(mocks.resolveBotCreation).not.toHaveBeenCalled();
  });
});
