import { describe, expect, it, vi } from "vitest";
import { fitInlineFiles, subscriptionModel } from "./subscription-model";

const { createOpenAI, models } = vi.hoisted(() => {
  const recordedModels: Record<string, unknown>[] = [];
  const create = vi.fn((options: { fetch?: typeof fetch }) => ({
    options,
    responses: (modelId: string) => {
      const model = {
        doGenerate: vi.fn(),
        doStream: vi.fn(),
        modelId,
        provider: "busy-test.responses",
        specificationVersion: "v4" as const,
        supportedUrls: {},
      };
      recordedModels.push(model);
      return model;
    },
  }));
  return { createOpenAI: create, models: recordedModels };
});
const getVercelOidcToken = vi.hoisted(() => vi.fn(async () => "oidc-token"));

vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken }));

describe("subscription model runtime", () => {
  it("creates a namespaced ChatGPT model behind the hub proxy", () => {
    vi.stubEnv("HUB_URL", "https://busy.test/");
    expect(subscriptionModel("chatgpt", "chatgpt/gpt-6.1-sol")).toMatchObject({
      modelId: "gpt-6.1-sol",
      specificationVersion: "v4",
    });
    expect(createOpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://busy.test/api/bot/ai",
        name: "busy-chatgpt",
      })
    );
    vi.unstubAllEnvs();
  });

  it("rejects unnamespaced models so a bot cannot cross providers", () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    expect(() => subscriptionModel("grok", "openai/gpt-6.1-sol")).toThrow(
      "grok/ prefix"
    );
    vi.unstubAllEnvs();
  });

  it("namespaces provider metadata emitted by the OpenAI SDK", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    const model = subscriptionModel("chatgpt", "chatgpt/gpt-6.1-sol");
    const baseModel = models.at(-1) as
      | {
          doGenerate: ReturnType<typeof vi.fn>;
          doStream: ReturnType<typeof vi.fn>;
        }
      | undefined;
    if (!baseModel) {
      throw new Error("expected the OpenAI model to be created");
    }
    const result = {
      content: [
        {
          providerMetadata: {
            anthropic: { cacheControl: "ephemeral" },
            openai: {
              itemId: "rs_chatgpt",
              reasoningEncryptedContent: "encrypted-chatgpt",
            },
          },
          text: "answer",
          type: "reasoning",
        },
      ],
      finishReason: { raw: "stop", unified: "stop" },
      providerMetadata: {
        custom: { source: "other-provider" },
        openai: { responseId: "resp_chatgpt" },
      },
      usage: {
        inputTokens: 1,
        outputTokens: { reasoning: 0, text: 1, total: 1 },
        totalTokens: 2,
      },
    };
    baseModel.doGenerate.mockResolvedValue(result);

    const generated = await model.doGenerate({ prompt: [] });
    expect(generated.content[0]?.providerMetadata).toEqual({
      anthropic: { cacheControl: "ephemeral" },
      "busy-chatgpt": {
        itemId: "rs_chatgpt",
        reasoningEncryptedContent: "encrypted-chatgpt",
      },
    });
    expect(generated.providerMetadata).toEqual({
      "busy-chatgpt": { responseId: "resp_chatgpt" },
      custom: { source: "other-provider" },
    });
    vi.unstubAllEnvs();
  });

  it("namespaces provider metadata emitted by a stream", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    const model = subscriptionModel("grok", "grok/grok-4.7");
    const baseModel = models.at(-1) as
      | {
          doGenerate: ReturnType<typeof vi.fn>;
          doStream: ReturnType<typeof vi.fn>;
        }
      | undefined;
    if (!baseModel) {
      throw new Error("expected the OpenAI model to be created");
    }
    baseModel.doStream.mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({
            id: "rs_grok",
            providerMetadata: {
              openai: { itemId: "rs_grok" },
            },
            type: "reasoning-end",
          });
          controller.close();
        },
      }),
    });

    const result = await model.doStream({ prompt: [] });
    const reader = result.stream.getReader();
    const first = await reader.read();
    const metadata =
      first.value && "providerMetadata" in first.value
        ? first.value.providerMetadata
        : undefined;
    expect(metadata).toEqual({
      "busy-grok": { itemId: "rs_grok" },
    });
    vi.unstubAllEnvs();
  });

  it("sanitizes provider failures before the AI SDK can persist them", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    const upstream = vi.fn(async () =>
      Response.json(
        { error: "subscription_auth_required", message: "secret access token" },
        { status: 401 }
      )
    );
    vi.stubGlobal("fetch", upstream);
    subscriptionModel("grok", "grok/grok-4.7");
    const options = createOpenAI.mock.calls.at(-1)?.[0];
    const request = await options?.fetch?.("https://busy.test/api/bot/ai", {});
    expect(request?.status).toBe(401);
    const body = await request?.json();
    expect(body).toEqual({
      error: {
        code: "subscription_auth_required",
        message: "Grok could not complete this request.",
        type: "busy_subscription_error",
      },
      provider: "grok",
    });
    expect(JSON.stringify(body)).not.toContain("secret access token");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("turns a network failure into a fixed provider error", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("token=secret");
      })
    );
    subscriptionModel("chatgpt", "chatgpt/gpt-6.1-sol");
    const options = createOpenAI.mock.calls.at(-1)?.[0];
    await expect(
      options?.fetch?.("https://busy.test/api/bot/ai", {})
    ).rejects.toThrow("ChatGPT subscription is temporarily unavailable.");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it("preserves the hub's canonical provider issue code", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            action: "settings",
            code: "connection_not_connected",
            error: "connection_not_connected",
            message: "safe message",
            provider: "grok",
          },
          { status: 409 }
        )
      )
    );
    subscriptionModel("grok", "grok/grok-4.7");
    const options = createOpenAI.mock.calls.at(-1)?.[0];
    const request = await options?.fetch?.("https://busy.test/api/bot/ai", {});
    expect(await request?.json()).toMatchObject({
      error: { code: "connection_not_connected" },
      provider: "grok",
    });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("sanitizes provider failure events inside a successful SSE response", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    const event = [
      "event: response.failed",
      `data: ${JSON.stringify({
        response: {
          error: {
            code: "provider_rate_limited",
            message: "secret provider body",
          },
        },
        type: "response.failed",
      })}`,
      "",
      `data: ${JSON.stringify({ delta: "hello", type: "response.output_text.delta" })}`,
      "",
      `data: ${JSON.stringify({ code: "private-code", message: "secret top-level", sequence_number: 4, type: "error" })}`,
      "data: [DONE]",
    ].join("\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(event, {
            headers: { "content-type": "text/event-stream" },
          })
      )
    );
    subscriptionModel("chatgpt", "chatgpt/gpt-6.1-sol");
    const options = createOpenAI.mock.calls.at(-1)?.[0];
    const request = await options?.fetch?.("https://busy.test/api/bot/ai", {});
    const body = await request?.text();
    expect(body).not.toContain("secret provider body");
    expect(body).not.toContain("private-code");
    expect(body).not.toContain("secret top-level");
    expect(body).toContain("hello");
    expect(body).toContain("provider_rate_limited");
    expect(body).toContain('"provider":"chatgpt"');

    const topLevelError = body
      ?.split("\n")
      .find(
        (line) => line.startsWith("data:") && line.includes('"type":"error"')
      );
    expect(topLevelError).toContain('"code":"subscription_request_failed"');
    expect(topLevelError).toContain(
      '"message":"ChatGPT could not complete this request."'
    );
    expect(topLevelError).not.toContain('"error":');
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("fitInlineFiles", () => {
  const image = (name: string, bytes: number) => ({
    data: { data: "A".repeat(Math.ceil((bytes * 4) / 3)), type: "data" },
    filename: name,
    mediaType: "image/png",
    type: "file",
  });
  const toolResult = (...value: unknown[]) => ({
    content: [
      {
        output: { type: "content", value },
        toolCallId: "c",
        toolName: "read_file",
        type: "tool-result",
      },
    ],
    role: "tool",
  });

  it("keeps the newest files within the budget and notes the rest", () => {
    const prompt = [
      { content: [image("old.png", 600)], role: "user" },
      toolResult(image("big.png", 3000)),
      toolResult({ text: "ok", type: "text" }, image("new.png", 600)),
    ] as never;
    const out = fitInlineFiles(prompt, 1000) as unknown as {
      content: {
        output?: { value: { type: string; text?: string }[] };
        type: string;
        text?: string;
      }[];
    }[];
    expect(out[2]?.content[0]?.output?.value[1]?.type).toBe("file");
    expect(out[1]?.content[0]?.output?.value[0]?.text).toContain("big.png");
    expect(out[0]?.content[0]?.type).toBe("text");
    expect(out[0]?.content[0]?.text).toContain("old.png");
  });

  it("leaves a prompt without files untouched", () => {
    const prompt = [
      { content: [{ text: "hi", type: "text" }], role: "user" },
    ] as never;
    expect(fitInlineFiles(prompt)).toEqual(prompt);
  });
});
