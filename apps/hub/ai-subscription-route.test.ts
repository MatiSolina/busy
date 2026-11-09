import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bot/ai/responses/route";
import { SubscriptionConnectionError } from "./lib/ai/subscription-types";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  getBot: vi.fn(),
  getSubscriptionAccess: vi.fn(),
  invalidateSubscriptionAccess: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/ai/subscription-store", () => ({
  getSubscriptionAccess: mocks.getSubscriptionAccess,
  invalidateSubscriptionAccess: mocks.invalidateSubscriptionAccess,
}));

const access = {
  credentials: {
    accessToken: "subscription-secret",
    accountId: "account-1",
    clientId: "client-1",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh-secret",
  },
  models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
};

const request = (body: unknown) =>
  new Request("https://busy.test/api/bot/ai/responses", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.botFromRequest.mockResolvedValue({ slug: "bot" });
  mocks.getBot.mockResolvedValue({
    billing: "grok",
    model: "grok/grok-4.7",
    slug: "bot",
  });
  mocks.getSubscriptionAccess.mockResolvedValue(access);
  mocks.invalidateSubscriptionAccess.mockResolvedValue(true);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("data: done\n\n", {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
    )
  );
});

describe("bot subscription responses route", () => {
  it("gives already-deployed bots cache affinity from their persisted session", async () => {
    mocks.getBot.mockResolvedValue({
      billing: "grok",
      model: "grok/grok-4.7",
      sessionId: "persisted-session",
      slug: "bot",
    });
    await POST(request({ input: "hello", model: "grok-4.7" }));
    const [call] = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.prompt_cache_key).toBe(
      createHash("sha256").update("grok\u0000persisted-session").digest("hex")
    );
  });

  it("preserves a runtime's child-session affinity instead of using the root session", async () => {
    mocks.getBot.mockResolvedValue({
      billing: "grok",
      model: "grok/grok-4.7",
      sessionId: "root-session",
      slug: "bot",
    });
    await POST(
      request({
        input: "hello",
        model: "grok-4.7",
        prompt_cache_key: "child-session-hash",
      })
    );
    const [call] = (fetch as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.parse(String(call?.[1]?.body)).prompt_cache_key).toBe(
      "child-session-hash"
    );
  });

  it("sends the Grok proxy version header required for inference", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        if (headers.get("x-grok-client-version") !== "1.0.13") {
          return Response.json(
            { error: "Your Grok CLI version (none) is outdated." },
            { status: 426 }
          );
        }
        return new Response("data: done\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      })
    );

    const response = await POST(request({ input: "hello", model: "grok-4.7" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("data: done\n\n");
  });

  it("authenticates the bot, forwards an allowlisted stream, and never returns provider tokens", async () => {
    const response = await POST(
      request({
        input: [{ content: "hello", role: "user" }],
        model: "grok-4.7",
        secret: "drop",
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toContain("data: done");
    const call = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(call[0]).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(JSON.parse(String(call[1].body))).toEqual({
      input: [{ content: "hello", role: "user" }],
      model: "grok-4.7",
      store: false,
      stream: true,
    });
    expect(JSON.stringify(call[1].headers)).not.toContain(
      "subscription-secret"
    );
  });

  it("rejects a model from another provider before calling upstream", async () => {
    const response = await POST(request({ input: [], model: "gpt-6.1-sol" }));
    expect(response.status).toBe(400);
    expect(mocks.getSubscriptionAccess).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not route gateway or Token Pass bots through subscription access", async () => {
    mocks.getBot.mockResolvedValue({
      billing: "gateway",
      model: "openai/gpt-6.1-sol",
      slug: "bot",
    });
    const response = await POST(request({ input: [], model: "gpt-6.1-sol" }));
    expect(response.status).toBe(409);
    expect(mocks.getSubscriptionAccess).not.toHaveBeenCalled();
  });

  it("returns a reconnect message when a stored OAuth grant has expired", async () => {
    mocks.getSubscriptionAccess.mockRejectedValue(
      new SubscriptionConnectionError(
        "provider returned invalid_grant",
        "connection_expired"
      )
    );
    const response = await POST(request({ input: [], model: "grok-4.7" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      action: "settings",
      code: "connection_expired",
      error: "connection_expired",
      message: "Your Grok connection expired. Reconnect it in Settings.",
      provider: "grok",
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("invalidates the exact grant after a provider 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "invalid_token" }, { status: 401 })
      )
    );
    const response = await POST(request({ input: [], model: "grok-4.7" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "connection_not_connected",
      provider: "grok",
    });
    expect(mocks.invalidateSubscriptionAccess).toHaveBeenCalledWith(
      "grok",
      access.credentials
    );
  });
});
