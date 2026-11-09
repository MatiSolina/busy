import { createOpenAI } from "@ai-sdk/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriptionModelOptions } from "../agent";
import { subscriptionModel } from "./subscription-model";

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: vi.fn(async () => "oidc-token"),
}));

const SHA256_HEX = /^[0-9a-f]{64}$/u;

type OpenAiPrompt = Parameters<
  ReturnType<ReturnType<typeof createOpenAI>["responses"]>["doGenerate"]
>[0]["prompt"];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function promptWithMetadata(
  namespace: "busy-chatgpt" | "busy-grok" | "openai"
): OpenAiPrompt {
  return [
    {
      content: [
        {
          providerOptions: {
            [namespace]: {
              promptCacheBreakpoint: { mode: "explicit", ttl: "30m" },
            },
          },
          text: "Find the result",
          type: "text",
        },
      ],
      role: "user" as const,
    },
    {
      content: [
        {
          providerOptions: {
            [namespace]: {
              itemId: `${namespace}-rs_previous`,
              reasoningEncryptedContent: `${namespace}-encrypted-reasoning`,
            },
          },
          text: "I checked the source.",
          type: "reasoning" as const,
        },
        {
          input: { query: "result" },
          providerOptions: {
            [namespace]: {
              itemId: `${namespace}-fc_previous`,
              ...(namespace === "openai"
                ? {
                    async: true,
                    caller: { callerId: "foreign", type: "program" },
                    namespace: "foreign_namespace",
                  }
                : {}),
            },
          },
          toolCallId: `${namespace}-call_previous`,
          toolName: "lookup",
          type: "tool-call" as const,
        },
      ],
      role: "assistant" as const,
    },
    {
      content: [
        {
          output: { type: "json", value: { answer: "42" } },
          providerOptions: {
            [namespace]: {
              additionalTools: [
                {
                  name: "later",
                  parameters: { properties: {}, type: "object" },
                  type: "function",
                },
              ],
            },
          },
          toolCallId: `${namespace}-call_previous`,
          toolName: "lookup",
          type: "tool-result" as const,
        },
      ],
      role: "tool" as const,
    },
    {
      content: [{ text: "Continue from that result.", type: "text" }],
      role: "user" as const,
    },
  ];
}

async function captureRequest(
  prompt: ReturnType<typeof promptWithMetadata>,
  provider: "chatgpt" | "grok" = "chatgpt",
  sessionId?: string
) {
  let requestBody: Record<string, unknown> | undefined;
  vi.stubEnv("HUB_URL", "https://busy.test");
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Promise.reject(new Error("captured request"));
    })
  );

  try {
    await subscriptionModel(
      provider,
      `${provider}/${provider === "chatgpt" ? "gpt-6.1-sol" : "grok-4.7"}`,
      sessionId
    ).doGenerate({
      prompt,
      providerOptions: subscriptionModelOptions.providerOptions,
    });
  } catch {
    // The fetch stub intentionally aborts after capturing the serialized body.
  }
  return requestBody;
}

describe("subscription Responses serialization", () => {
  it("asks ChatGPT for implicit 30m prompt caching with the session cache key", async () => {
    const requestBody = await captureRequest(
      promptWithMetadata("busy-chatgpt"),
      "chatgpt",
      "session-1"
    );
    expect(requestBody?.prompt_cache_key).toMatch(SHA256_HEX);
    expect(requestBody?.prompt_cache_options).toEqual({
      mode: "implicit",
      ttl: "30m",
    });
  });

  it("does not send ChatGPT cache options to Grok", async () => {
    const requestBody = await captureRequest(
      promptWithMetadata("busy-grok"),
      "grok",
      "session-1"
    );
    expect(requestBody?.prompt_cache_key).toMatch(SHA256_HEX);
    expect(requestBody).not.toHaveProperty("prompt_cache_options");
  });

  it("drops legacy OpenAI-keyed provider metadata before replaying history", async () => {
    const prompt = promptWithMetadata("openai");
    const requestBody = await captureRequest(prompt);

    expect(requestBody).toBeDefined();
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.include).toEqual(["reasoning.encrypted_content"]);
    const input = requestBody?.input as Record<string, unknown>[];
    expect(JSON.stringify(prompt)).toContain("openai-rs_previous");
    expect(JSON.stringify(input)).not.toContain("openai-rs_previous");
    expect(JSON.stringify(input)).not.toContain("openai-encrypted-reasoning");
    expect(input.some((item) => item.type === "reasoning")).toBe(false);
    expect(input.some((item) => item.type === "item_reference")).toBe(false);
    expect(input).toContainEqual(
      expect.objectContaining({
        content: [
          expect.objectContaining({
            prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" },
            text: "Find the result",
            type: "input_text",
          }),
        ],
        role: "user",
      })
    );
    expect(input).toContainEqual({
      role: "developer",
      tools: [
        {
          name: "later",
          parameters: { properties: {}, type: "object" },
          type: "function",
        },
      ],
      type: "additional_tools",
    });
    const functionCall = input.find((item) => item.type === "function_call");
    expect(functionCall).not.toHaveProperty("namespace");
    expect(functionCall).not.toHaveProperty("async");
    expect(functionCall).not.toHaveProperty("caller");
  });

  it("retains same-provider encrypted reasoning and tool history with storage disabled", async () => {
    const requestBody = await captureRequest(
      promptWithMetadata("busy-chatgpt")
    );

    expect(requestBody).toBeDefined();
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.include).toEqual(["reasoning.encrypted_content"]);
    const input = requestBody?.input as Record<string, unknown>[];
    expect(input.some((item) => item.type === "item_reference")).toBe(false);
    expect(input).toContainEqual(
      expect.objectContaining({
        encrypted_content: "busy-chatgpt-encrypted-reasoning",
        id: "busy-chatgpt-rs_previous",
        type: "reasoning",
      })
    );
    expect(input).toContainEqual(
      expect.objectContaining({
        call_id: "busy-chatgpt-call_previous",
        name: "lookup",
        type: "function_call",
      })
    );
    expect(input).toContainEqual(
      expect.objectContaining({
        call_id: "busy-chatgpt-call_previous",
        type: "function_call_output",
      })
    );
  });

  it("inlines replayed reasoning and tool turns when upstream storage is disabled", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAI({
      apiKey: "test-key",
      baseURL: "https://busy.test/v1",
      fetch: (_input, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        throw new Error("captured request");
      },
    });
    const model = provider.responses("gpt-6.1-sol");

    await expect(
      model.doGenerate({
        prompt: [
          {
            content: [{ text: "Find the result", type: "text" }],
            role: "user",
          },
          {
            content: [
              {
                providerOptions: {
                  openai: {
                    itemId: "rs_previous",
                    reasoningEncryptedContent: "encrypted-reasoning",
                  },
                },
                text: "I checked the source.",
                type: "reasoning",
              },
              {
                input: { query: "result" },
                providerOptions: { openai: { itemId: "fc_previous" } },
                toolCallId: "call_previous",
                toolName: "lookup",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
          {
            content: [
              {
                output: { type: "json", value: { answer: "42" } },
                toolCallId: "call_previous",
                toolName: "lookup",
                type: "tool-result",
              },
            ],
            role: "tool",
          },
          {
            content: [{ text: "Continue from that result.", type: "text" }],
            role: "user",
          },
        ],
        providerOptions: subscriptionModelOptions.providerOptions,
      })
    ).rejects.toThrow("captured request");

    expect(requestBody).toBeDefined();
    expect(requestBody?.store).toBe(false);
    expect(requestBody?.include).toEqual(["reasoning.encrypted_content"]);

    const input = requestBody?.input as Record<string, unknown>[];
    expect(input.some((item) => item.type === "item_reference")).toBe(false);
    expect(input).toContainEqual(
      expect.objectContaining({
        encrypted_content: "encrypted-reasoning",
        id: "rs_previous",
        type: "reasoning",
      })
    );
    expect(input).toContainEqual(
      expect.objectContaining({
        call_id: "call_previous",
        name: "lookup",
        type: "function_call",
      })
    );
    expect(input).toContainEqual(
      expect.objectContaining({
        call_id: "call_previous",
        type: "function_call_output",
      })
    );
  });
});
