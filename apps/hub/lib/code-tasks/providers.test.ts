import { createFxEngine } from "libfx";
import { describe, expect, it, vi } from "vitest";
import {
  type CodeTaskProfile,
  codeTaskModel,
  createFxTransport,
  type FxTransportDependencies,
  lookupGatewayGeneration,
  observeGatewayGeneration,
  providerOptions,
  type SubscriptionAccess,
} from "./providers";

interface RecordedRequest {
  init?: RequestInit;
  input: RequestInfo | URL;
}

const profile = (
  overrides: Partial<CodeTaskProfile> = {}
): CodeTaskProfile => ({
  billing: "chatgpt",
  fast: false,
  model: "chatgpt/gpt-6.1-sol",
  sessionId: "wrun_task_1",
  taskId: "task-1",
  ...overrides,
});

describe("Gateway generation usage", () => {
  it("captures generation metadata without changing streaming bytes", async () => {
    const source =
      'data: {"type":"text-start","providerMetadata":{"gateway":{"generationId":"gen_01TEST"}}}\n\n' +
      'data: {"type":"text-delta","delta":"ok"}\n\n';
    const captured: string[] = [];
    const observed = observeGatewayGeneration(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(source.slice(0, 17)));
            controller.enqueue(new TextEncoder().encode(source.slice(17)));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } }
      ),
      (id) => {
        captured.push(id);
      }
    );

    expect(await observed.text()).toBe(source);
    expect(captured).toEqual(["gen_01TEST"]);
  });

  it("looks up authoritative cost with the task's billing credential", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        data: {
          gateway_cost: 0.0012,
          id: "gen_01TEST",
          market_cost: 0.001,
          surcharge_cost: 0.0002,
          total_cost: 0.0012,
        },
      })
    );
    const result = await lookupGatewayGeneration(
      profile({ billing: "gateway", model: "openai/gpt-6.1-terra" }),
      "gen_01TEST",
      {
        fetch: fetcher,
        getGatewayCredential: vi.fn(async () => "oidc-token"),
        getTokenPassCredential: vi.fn(async () => "token-pass-token"),
      }
    );

    expect(result).toEqual({
      info: {
        gatewayCost: 0.0012,
        generationId: "gen_01TEST",
        marketCost: 0.001,
        surchargeCost: 0.0002,
        totalCost: 0.0012,
      },
      status: "ready",
    });
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toContain("/v1/generation?id=gen_01TEST");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer oidc-token"
    );
  });

  it("treats asynchronous ingestion 404 as pending", async () => {
    const result = await lookupGatewayGeneration(
      profile({ billing: "token-pass" }),
      "gen_01PENDING",
      {
        fetch: vi.fn<typeof fetch>(
          async () => new Response(null, { status: 404 })
        ),
        getGatewayCredential: vi.fn(async () => "oidc-token"),
        getTokenPassCredential: vi.fn(async () => "token-pass-token"),
      }
    );
    expect(result).toEqual({ status: "pending" });
  });
});

const access: SubscriptionAccess = {
  credentials: {
    accessToken: "access-token",
    accountId: "account-1",
    clientId: "busy-client",
    expiresAt: Date.now() + 300_000,
    refreshToken: "must-not-leave-hub",
  },
  models: [{ id: "gpt-6.1-sol", label: "GPT 6.1 Sol" }],
};

function dependencies(
  current: CodeTaskProfile,
  fetch: typeof globalThis.fetch,
  subscriptionAccess: SubscriptionAccess = access
): FxTransportDependencies {
  return {
    fetch,
    getGatewayCredential: vi.fn(async () => "oidc-token"),
    getSubscriptionAccess: vi.fn(async () => subscriptionAccess),
    getTokenPassCredential: vi.fn(async () => "token-pass-token"),
    lookupTask: vi.fn(async (sessionId: string) =>
      sessionId === current.sessionId ? current : null
    ),
  };
}

describe("fx provider profiles", () => {
  it("keeps stable named profiles without reading credentials", () => {
    expect(providerOptions("gateway")).toMatchObject({
      agentName: "busy-code-gateway",
      credentialMode: "vercel-oidc",
      provider: "gateway",
    });
    expect(providerOptions("token-pass")).toMatchObject({
      agentName: "busy-code-token-pass",
      credentialMode: "token-pass",
      provider: "gateway",
    });
    expect(providerOptions("chatgpt")).toMatchObject({
      agentName: "busy-code-chatgpt",
      provider: "codex",
      requiresBusyTransport: true,
    });
    expect(providerOptions("grok")).toMatchObject({
      agentName: "busy-code-grok",
      provider: "grok",
      requiresBusyTransport: true,
    });
  });
});

describe("createFxTransport", () => {
  it("maps the native Codex endpoint to Busy Responses and strips refresh credentials", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, responseInit) =>
        new Response(
          JSON.stringify({
            body: JSON.parse(String(responseInit?.body)),
            ok: true,
          }),
          { status: 200 }
        )
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        body: JSON.stringify({
          ignored_secret: "drop",
          input: "hello",
          model: "gpt-6.1-sol",
          previous_response_id: undefined,
        }),
        headers: { "session-id": "wrun_task_1" },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    expect(upstream).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        body: expect.stringContaining('"model":"gpt-6.1-sol"'),
      })
    );
    const [firstCall] = upstream.mock.calls;
    expect(firstCall).toBeDefined();
    const [, callInit] = firstCall ?? [];
    const headers = new Headers(callInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("refresh-token")).toBeNull();
    expect(String(callInit?.body)).not.toContain("ignored_secret");
  });

  it("serves a bounded subscription catalog without an upstream call", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upstream = vi.fn<typeof fetch>(
      async () => new Response("should not run")
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)(
      "https://chatgpt.com/backend-api/codex/models",
      {
        headers: { "session-id": "wrun_task_1" },
      }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: "gpt-6.1-sol", object: "model", owned_by: "busy" }],
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("does not observe a task-scoped Gateway model catalog request", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const upstream = vi.fn<typeof fetch>(
      async () => new Response("should not run")
    );
    const current = profile({
      billing: "gateway",
      model: "openai/gpt-6.1-terra",
      sessionId: "wrun_gateway_catalog",
    });
    const deps = dependencies(current, upstream);
    deps.getGatewayModelCatalog = vi.fn(async () => ({
      data: [{ id: current.model, object: "model" }],
    }));
    const response = await createFxTransport(deps)(
      "https://ai-gateway.vercel.sh/coding-agent/v1/models",
      {
        headers: { "session-id": current.sessionId },
        method: "GET",
      }
    );
    expect(await response.json()).toEqual({
      data: [{ id: current.model, object: "model" }],
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("serves native subscription catalogs before a session exists", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () => new Response("must not run")
    );
    const current = profile({
      billing: "grok",
      model: "grok/grok-4.7",
      sessionId: "wrun_grok_catalog",
    });
    const grokAccess: SubscriptionAccess = {
      credentials: {
        accessToken: "grok-access-token",
        accountId: "grok-account-1",
        clientId: "busy-client",
        expiresAt: Date.now() + 300_000,
        refreshToken: "grok-refresh-must-not-leave-hub",
      },
      models: [{ id: "grok-4.7", label: "Grok 4.7" }],
    };
    const deps = dependencies(current, upstream, grokAccess);
    const response = await createFxTransport(deps)(
      "https://cli-chat-proxy.grok.com/v1/models",
      { method: "GET" }
    );
    expect(await response.json()).toEqual({
      data: [{ id: "grok-4.7", object: "model", owned_by: "busy" }],
    });
    expect(upstream).not.toHaveBeenCalled();
    expect(deps.lookupTask).not.toHaveBeenCalled();
  });

  it("uses the selected model and rejects an unknown session", async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response("ok"));
    const deps = dependencies(profile(), upstream);
    await expect(
      createFxTransport(deps)(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          body: JSON.stringify({ input: "hello", model: "other-model" }),
          headers: { "session-id": "other-session" },
          method: "POST",
        }
      )
    ).rejects.toThrow("unknown task session");
    await expect(
      createFxTransport(deps)(
        "https://chatgpt.com/backend-api/codex/responses",
        {
          body: JSON.stringify({ input: "hello", model: "other-model" }),
          headers: { "session-id": "wrun_task_1" },
          method: "POST",
        }
      )
    ).rejects.toThrow("model does not match");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never falls back from Token Pass to the OIDC credential", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, init) => new Response(String(init?.headers))
    );
    const current = profile({
      billing: "token-pass",
      model: "moonshotai/kimi-k3",
    });
    const deps = dependencies(current, upstream);
    const response = await createFxTransport(deps)(
      "https://ai-gateway.vercel.sh/v1/chat/completions",
      {
        body: JSON.stringify({ messages: [], model: current.model }),
        headers: {
          "api-key": "off-provider-secret",
          cookie: "off-provider-cookie",
          "refresh-token": "off-provider-refresh",
          "session-id": current.sessionId,
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(200);
    expect(
      new Headers(upstream.mock.calls[0]?.[1]?.headers).get("authorization")
    ).toBe("Bearer token-pass-token");
    const forwardedHeaders = new Headers(upstream.mock.calls[0]?.[1]?.headers);
    expect(forwardedHeaders.get("api-key")).toBeNull();
    expect(forwardedHeaders.get("cookie")).toBeNull();
    expect(forwardedHeaders.get("refresh-token")).toBeNull();
    expect(deps.getGatewayCredential).not.toHaveBeenCalled();
  });

  it("does not retry or switch provider on an upstream 401", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ error: "Bearer upstream-secret" }), {
          headers: {
            "www-authenticate": "Bearer upstream-secret",
          },
          status: 401,
        })
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)(
      "https://chatgpt.com/backend-api/codex/responses",
      {
        body: JSON.stringify({ input: "hello", model: "gpt-6.1-sol" }),
        headers: { "session-id": "wrun_task_1" },
        method: "POST",
      }
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: { code: "provider_request_failed", status: 401 },
    });
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("retry-after")).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(deps.getGatewayCredential).not.toHaveBeenCalled();
  });

  it.each([401, 429, 500])(
    "records upstream HTTP %s as a rejected or failed model request",
    async (status) => {
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const upstream = vi.fn<typeof fetch>(
        async () => new Response("provider body", { status })
      );
      const response = await createFxTransport(
        dependencies(profile(), upstream)
      )("https://chatgpt.com/backend-api/codex/responses", {
        body: JSON.stringify({ input: "hello", model: "gpt-6.1-sol" }),
        headers: { "session-id": "wrun_task_1" },
        method: "POST",
      });
      const records = info.mock.calls.map((call) =>
        JSON.parse(String(call[0]))
      );
      const terminal = records.find(
        (record) =>
          record.source === "busy.operation" &&
          record.stage === "model" &&
          record.httpStatus === status
      );
      expect(response.status).toBe(status);
      expect(terminal).toMatchObject({
        httpStatus: status,
        outcome: status >= 500 ? "failed" : "rejected",
      });
      expect(terminal).not.toHaveProperty("body");
      info.mockRestore();
    }
  );

  it("only permits libfx's unauthenticated Codex version probe without a session", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          JSON.stringify({
            authorization: new Headers(init?.headers).get("authorization"),
            cookie: new Headers(init?.headers).get("cookie"),
            version: "0.0.0-test",
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)(
      "https://registry.npmjs.org/@openai/codex/latest",
      {
        headers: {
          authorization: "Bearer off-provider-secret",
          cookie: "off-provider-cookie",
        },
        method: "GET",
      }
    );
    expect(await response.json()).toEqual({
      authorization: null,
      cookie: null,
      version: "0.0.0-test",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(deps.lookupTask).not.toHaveBeenCalled();
  });

  it("allows only the public Gateway catalog GET without a session", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          JSON.stringify({
            authorization: new Headers(init?.headers).get("authorization"),
            cookie: new Headers(init?.headers).get("cookie"),
            data: [{ id: "openai/gpt-6.1-terra", type: "language" }],
            object: "list",
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)(
      "https://ai-gateway.vercel.sh/coding-agent/v1/models",
      {
        headers: {
          authorization: "Bearer off-provider-secret",
          cookie: "off-provider-cookie",
        },
        method: "GET",
      }
    );
    expect(await response.json()).toEqual({
      authorization: null,
      cookie: null,
      data: [{ id: "openai/gpt-6.1-terra", type: "language" }],
      object: "list",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(deps.lookupTask).not.toHaveBeenCalled();
    expect(deps.getGatewayModelCatalog).toBeUndefined();
  });

  it("only permits libfx's unauthenticated Grok version probe without a session", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(
          JSON.stringify({
            authorization: new Headers(init?.headers).get("authorization"),
            cookie: new Headers(init?.headers).get("cookie"),
            version: "1.0.70",
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
    );
    const deps = dependencies(profile(), upstream);
    const response = await createFxTransport(deps)("https://x.ai/cli/stable", {
      headers: {
        authorization: "Bearer off-provider-secret",
        cookie: "off-provider-cookie",
      },
      method: "GET",
    });
    expect(await response.json()).toEqual({
      authorization: null,
      cookie: null,
      version: "1.0.70",
    });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(deps.lookupTask).not.toHaveBeenCalled();
  });

  it("sanitizes Gateway 429s without falling back and preserves safe retry-after", async () => {
    const upstream = vi.fn<typeof fetch>(
      async () =>
        new Response("Bearer gateway-secret", {
          headers: { "retry-after": "30" },
          status: 429,
        })
    );
    const current = profile({
      billing: "gateway",
      model: "openai/gpt-6.1-terra",
    });
    const deps = dependencies(current, upstream);
    const response = await createFxTransport(deps)(
      "https://ai-gateway.vercel.sh/v4/ai/language-model",
      {
        body: JSON.stringify({ prompt: [] }),
        headers: {
          "ai-language-model-id": current.model,
          "x-session-id": current.sessionId,
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.text()).not.toContain("gateway-secret");
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(deps.getGatewayCredential).toHaveBeenCalledTimes(1);
    expect(deps.getTokenPassCredential).not.toHaveBeenCalled();
  });

  it("maps Busy Fast to Gateway priority without enabling libfx native fast", async () => {
    const upstream = vi.fn<typeof fetch>(
      async (_input, init) =>
        new Response(JSON.stringify({ body: JSON.parse(String(init?.body)) }), {
          headers: { "content-type": "application/json" },
          status: 200,
        })
    );
    const current = profile({
      billing: "gateway",
      fast: true,
      model: "spacexai/grok-4.7",
    });
    const deps = dependencies(current, upstream);
    const response = await createFxTransport(deps)(
      "https://ai-gateway.vercel.sh/v4/ai/language-model",
      {
        body: JSON.stringify({
          prompt: [],
          providerOptions: { gateway: { order: ["spacexai"] } },
        }),
        headers: {
          "ai-language-model-id": current.model,
          "x-session-id": current.sessionId,
        },
        method: "POST",
      }
    );
    const body = (await response.json()) as {
      body: { providerOptions: { gateway: Record<string, unknown> } };
    };
    expect(body.body.providerOptions.gateway).toEqual({
      order: ["spacexai"],
      serviceTier: "priority",
    });
    expect(deps.getGatewayCredential).toHaveBeenCalledOnce();
  });

  it("runs a real libfx engine through the gateway fetch adapter", async () => {
    const calls: RecordedRequest[] = [];
    const current = profile({
      billing: "gateway",
      model: "openai/gpt-6.1-terra",
      sessionId: "wrun_gateway_1",
    });
    const deps = dependencies(current, (input, init) => {
      calls.push({ init, input });
      const stream = [
        'data: {"type":"stream-start","warnings":[]}\n\n',
        'data: {"type":"text-start","id":"text-1"}\n\n',
        'data: {"type":"text-delta","id":"text-1","delta":"hello"}\n\n',
        'data: {"type":"text-end","id":"text-1"}\n\n',
        'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1,"noCache":1,"cacheRead":0,"cacheWrite":0},"outputTokens":{"total":1,"text":1,"reasoning":0}}}\n\n',
        "data: [DONE]\n\n",
      ].join("");
      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
      );
    });
    const engine = await createFxEngine({
      apiKey: "placeholder-owned-by-busy-transport",
      fetch: createFxTransport(deps),
      model: "openai/gpt-6.1-terra",
      modelCatalog: [
        {
          contextWindow: 128_000,
          id: "openai/gpt-6.1-terra",
          maxOutputTokens: 1024,
          supportsToolUse: true,
        },
      ],
      sessionId: current.sessionId,
    });
    try {
      const turn = engine.prompt("hello");
      const result = await turn.result;
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.input)).toBe(
        "https://ai-gateway.vercel.sh/v4/ai/language-model"
      );
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("x-session-id")).toBeTruthy();
      expect(headers.get("authorization")).toBe("Bearer oidc-token");
      expect(headers.get("authorization")).not.toBe(
        "Bearer placeholder-owned-by-busy-transport"
      );
    } finally {
      await engine.close();
    }
  });

  it("runs Grok 4.7 with Busy Fast through the Gateway priority option", async () => {
    const calls: RecordedRequest[] = [];
    const current = profile({
      billing: "gateway",
      fast: true,
      model: "spacexai/grok-4.7",
      sessionId: "wrun_gateway_fast_1",
    });
    const deps = dependencies(current, (input, init) => {
      calls.push({ init, input });
      return Promise.resolve(
        new Response(
          [
            'data: {"type":"stream-start","warnings":[]}\n\n',
            'data: {"type":"text-start","id":"text-fast"}\n\n',
            'data: {"type":"text-delta","id":"text-fast","delta":"priority"}\n\n',
            'data: {"type":"text-end","id":"text-fast"}\n\n',
            'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":1},"outputTokens":{"total":1}}}\n\n',
            "data: [DONE]\n\n",
          ].join(""),
          { headers: { "content-type": "text/event-stream" }, status: 200 }
        )
      );
    });
    const engine = await createFxEngine({
      apiKey: "placeholder-owned-by-busy-transport",
      fetch: createFxTransport(deps),
      model: codeTaskModel(current),
      modelCatalog: [
        {
          id: "spacexai/grok-4.7",
          pricing: { service_tiers: { priority: { input: "x" } } },
        },
      ],
      provider: "gateway",
      sessionId: current.sessionId,
    });
    try {
      const result = await engine.prompt("hello").result;
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toHaveLength(1);
      const body = JSON.parse(String(calls[0]?.init?.body)) as {
        providerOptions?: { gateway?: { serviceTier?: string } };
      };
      expect(body.providerOptions?.gateway?.serviceTier).toBe("priority");
    } finally {
      await engine.close();
    }
  });

  it("completes a real libfx host-tool roundtrip through the gateway", async () => {
    const calls: RecordedRequest[] = [];
    const toolInputs: unknown[] = [];
    const current = profile({
      billing: "gateway",
      model: "openai/gpt-6.1-terra",
      sessionId: "wrun_tool_1",
    });
    const deps = dependencies(current, (input, init) => {
      calls.push({ init, input });
      const stream =
        calls.length === 1
          ? [
              'data: {"type":"stream-start","warnings":[]}\n\n',
              'data: {"type":"tool-input-start","id":"call-1","toolName":"echo","inputEncoding":"json"}\n\n',
              'data: {"type":"tool-input-delta","id":"call-1","delta":"{\\"value\\":\\"ping\\"}"}\n\n',
              'data: {"type":"tool-input-end","id":"call-1"}\n\n',
              'data: {"type":"tool-call","toolCallId":"call-1","toolName":"echo","input":"{\\"value\\":\\"ping\\"}"}\n\n',
              'data: {"type":"finish","finishReason":{"unified":"tool-calls","raw":"tool_calls"},"usage":{"inputTokens":{"total":1,"noCache":1,"cacheRead":0,"cacheWrite":0},"outputTokens":{"total":1,"text":0,"reasoning":0}}}\n\n',
              "data: [DONE]\n\n",
            ].join("")
          : [
              'data: {"type":"stream-start","warnings":[]}\n\n',
              'data: {"type":"text-start","id":"text-2"}\n\n',
              'data: {"type":"text-delta","id":"text-2","delta":"done"}\n\n',
              'data: {"type":"text-end","id":"text-2"}\n\n',
              'data: {"type":"finish","finishReason":{"unified":"stop","raw":"stop"},"usage":{"inputTokens":{"total":2,"noCache":2,"cacheRead":0,"cacheWrite":0},"outputTokens":{"total":1,"text":1,"reasoning":0}}}\n\n',
              "data: [DONE]\n\n",
            ].join("");
      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
      );
    });
    const engine = await createFxEngine({
      apiKey: "placeholder-owned-by-busy-transport",
      fetch: createFxTransport(deps),
      model: "openai/gpt-6.1-terra",
      modelCatalog: [
        {
          contextWindow: 128_000,
          id: "openai/gpt-6.1-terra",
          maxOutputTokens: 1024,
          supportsToolUse: true,
        },
      ],
      sessionId: current.sessionId,
      tools: [
        {
          description: "Echo a value for this synthetic roundtrip.",
          execute: (input: unknown) => {
            toolInputs.push(input);
            return { echoed: (input as { value: string }).value };
          },
          idempotent: true,
          inputSchema: {
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
            type: "object",
          },
          name: "echo",
        },
      ],
    });
    try {
      const turn = engine.prompt("use echo");
      const result = await turn.result;
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toHaveLength(2);
      expect(toolInputs).toEqual([{ value: "ping" }]);
      expect(String(calls[1]?.init?.body)).toContain("tool-result");
    } finally {
      await engine.close();
    }
  });

  it("runs a real Codex engine through the Busy Responses adapter", async () => {
    const calls: RecordedRequest[] = [];
    const fxRequests: RecordedRequest[] = [];
    const current = profile({
      billing: "chatgpt",
      model: "chatgpt/gpt-6.1-sol",
      sessionId: "wrun_codex_1",
    });
    const deps = dependencies(current, (input, init) => {
      calls.push({ init, input });
      const responseId = "resp_test";
      const messageId = "msg_test";
      const stream = [
        `event: response.created\ndata: ${JSON.stringify({
          response: {
            created_at: 1,
            id: responseId,
            model: "gpt-6.1-sol",
            object: "response",
            output: [],
            status: "in_progress",
          },
          type: "response.created",
        })}\n\n`,
        `event: response.output_item.added\ndata: ${JSON.stringify({
          item: {
            content: [],
            id: messageId,
            role: "assistant",
            status: "in_progress",
            type: "message",
          },
          output_index: 0,
          type: "response.output_item.added",
        })}\n\n`,
        `event: response.content_part.added\ndata: ${JSON.stringify({
          content_index: 0,
          item_id: messageId,
          output_index: 0,
          part: {
            annotations: [],
            logprobs: [],
            text: "",
            type: "output_text",
          },
          type: "response.content_part.added",
        })}\n\n`,
        `event: response.output_text.delta\ndata: ${JSON.stringify({
          content_index: 0,
          delta: "hello",
          item_id: messageId,
          logprobs: [],
          output_index: 0,
          type: "response.output_text.delta",
        })}\n\n`,
        `event: response.output_text.done\ndata: ${JSON.stringify({
          content_index: 0,
          item_id: messageId,
          logprobs: [],
          output_index: 0,
          text: "hello",
          type: "response.output_text.done",
        })}\n\n`,
        `event: response.content_part.done\ndata: ${JSON.stringify({
          content_index: 0,
          item_id: messageId,
          output_index: 0,
          part: {
            annotations: [],
            logprobs: [],
            text: "hello",
            type: "output_text",
          },
          type: "response.content_part.done",
        })}\n\n`,
        `event: response.output_item.done\ndata: ${JSON.stringify({
          item: {
            content: [
              {
                annotations: [],
                logprobs: [],
                text: "hello",
                type: "output_text",
              },
            ],
            id: messageId,
            role: "assistant",
            status: "completed",
            type: "message",
          },
          output_index: 0,
          type: "response.output_item.done",
        })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          response: {
            created_at: 1,
            id: responseId,
            model: "gpt-6.1-sol",
            object: "response",
            output: [
              {
                content: [
                  {
                    annotations: [],
                    logprobs: [],
                    text: "hello",
                    type: "output_text",
                  },
                ],
                id: messageId,
                role: "assistant",
                status: "completed",
                type: "message",
              },
            ],
            status: "completed",
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
          type: "response.completed",
        })}\n\n`,
        "event: done\ndata: [DONE]\n\n",
      ].join("");
      return Promise.resolve(
        new Response(stream, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
      );
    });
    const engine = await createFxEngine({
      apiKey: "placeholder-owned-by-busy-transport",
      credentials: () => ({
        accessToken: "native-libfx-placeholder",
        accountId: "account-1",
        expiresAt: Date.now() + 300_000,
      }),
      fetch: (input, init) => {
        fxRequests.push({ init, input });
        if (
          String(input) === "https://registry.npmjs.org/@openai/codex/latest"
        ) {
          return Promise.resolve(Response.json({ version: "0.0.0-test" }));
        }
        return createFxTransport(deps)(input, init);
      },
      model: "gpt-6.1-sol",
      provider: "codex",
      sessionId: current.sessionId,
    });
    try {
      const turn = engine.prompt("hello");
      const result = await turn.result;
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.input)).toBe(
        "https://api.openai.com/v1/responses"
      );
      const nativeRequest = fxRequests.find((request) =>
        String(request.input).endsWith("/backend-api/codex/responses")
      );
      expect(nativeRequest).toBeDefined();
      expect(
        fxRequests.some((request) => String(request.input).endsWith("/models"))
      ).toBe(false);
      expect(new Headers(nativeRequest?.init?.headers).get("session-id")).toBe(
        current.sessionId
      );
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer access-token");
      expect(headers.get("authorization")).not.toBe(
        "Bearer native-libfx-placeholder"
      );
      expect(headers.get("refresh-token")).toBeNull();
    } finally {
      await engine.close();
    }
  });

  it("runs a real Grok engine without a synthetic model catalog", async () => {
    const calls: RecordedRequest[] = [];
    const fxRequests: RecordedRequest[] = [];
    const current = profile({
      billing: "grok",
      model: "grok/grok-4.7",
      sessionId: "wrun_grok_1",
    });
    const grokAccess: SubscriptionAccess = {
      credentials: {
        accessToken: "grok-access-token",
        accountId: "grok-account-1",
        clientId: "busy-client",
        expiresAt: Date.now() + 300_000,
        refreshToken: "grok-refresh-must-not-leave-hub",
      },
      models: [{ id: "grok-4.7", label: "Grok 4.7" }],
    };
    const deps = dependencies(
      current,
      (input, init) => {
        calls.push({ init, input });
        const responseId = "grok-response-test";
        const messageId = "grok-message-test";
        const stream = [
          `event: response.created\ndata: ${JSON.stringify({
            response: {
              created_at: 1,
              id: responseId,
              model: "grok-4.7",
              object: "response",
              output: [],
              status: "in_progress",
            },
            type: "response.created",
          })}\n\n`,
          `event: response.output_item.added\ndata: ${JSON.stringify({
            item: {
              content: [],
              id: messageId,
              role: "assistant",
              status: "in_progress",
              type: "message",
            },
            output_index: 0,
            type: "response.output_item.added",
          })}\n\n`,
          `event: response.content_part.added\ndata: ${JSON.stringify({
            content_index: 0,
            item_id: messageId,
            output_index: 0,
            part: {
              annotations: [],
              logprobs: [],
              text: "",
              type: "output_text",
            },
            type: "response.content_part.added",
          })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({
            content_index: 0,
            delta: "hello",
            item_id: messageId,
            logprobs: [],
            output_index: 0,
            type: "response.output_text.delta",
          })}\n\n`,
          `event: response.output_text.done\ndata: ${JSON.stringify({
            content_index: 0,
            item_id: messageId,
            logprobs: [],
            output_index: 0,
            text: "hello",
            type: "response.output_text.done",
          })}\n\n`,
          `event: response.content_part.done\ndata: ${JSON.stringify({
            content_index: 0,
            item_id: messageId,
            output_index: 0,
            part: {
              annotations: [],
              logprobs: [],
              text: "hello",
              type: "output_text",
            },
            type: "response.content_part.done",
          })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({
            item: {
              content: [
                {
                  annotations: [],
                  logprobs: [],
                  text: "hello",
                  type: "output_text",
                },
              ],
              id: messageId,
              role: "assistant",
              status: "completed",
              type: "message",
            },
            output_index: 0,
            type: "response.output_item.done",
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            response: {
              created_at: 1,
              id: responseId,
              model: "grok-4.7",
              object: "response",
              output: [
                {
                  content: [
                    {
                      annotations: [],
                      logprobs: [],
                      text: "hello",
                      type: "output_text",
                    },
                  ],
                  id: messageId,
                  role: "assistant",
                  status: "completed",
                  type: "message",
                },
              ],
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
            type: "response.completed",
          })}\n\n`,
          "event: done\ndata: [DONE]\n\n",
        ].join("");
        return Promise.resolve(
          new Response(stream, {
            headers: { "content-type": "text/event-stream" },
            status: 200,
          })
        );
      },
      grokAccess
    );
    const engine = await createFxEngine({
      apiKey: "placeholder-owned-by-busy-transport",
      credentials: () => ({
        accessToken: "native-grok-placeholder",
        accountId: "grok-account-1",
        expiresAt: Date.now() + 300_000,
      }),
      fetch: (input, init) => {
        fxRequests.push({ init, input });
        if (String(input) === "https://x.ai/cli/stable") {
          return Promise.resolve(new Response("1.0.70", { status: 200 }));
        }
        return createFxTransport(deps)(input, init);
      },
      model: "grok-4.7",
      provider: "grok",
      sessionId: current.sessionId,
    });
    try {
      const turn = engine.prompt("hello");
      const result = await turn.result;
      expect(result.stopReason).toBe("end_turn");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.input)).toBe(
        "https://cli-chat-proxy.grok.com/v1/responses"
      );
      const nativeRequest = fxRequests.find((request) =>
        String(request.input).endsWith("/v1/responses")
      );
      expect(nativeRequest).toBeDefined();
      const nativeModelsRequest = fxRequests.find((request) =>
        String(request.input).endsWith("/v1/models")
      );
      expect(nativeModelsRequest).toBeDefined();
      expect(
        new Headers(nativeModelsRequest?.init?.headers).get("x-grok-conv-id")
      ).toBeNull();
      expect(
        new Headers(nativeRequest?.init?.headers).get("x-grok-conv-id")
      ).toBe(current.sessionId);
      const headers = new Headers(calls[0]?.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer grok-access-token");
      expect(headers.get("x-grok-user-id")).toBe("grok-account-1");
      expect(headers.get("x-grok-client-identifier")).toBe("busy");
    } finally {
      await engine.close();
    }
  });
});
