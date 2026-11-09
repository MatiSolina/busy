import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as broker } from "./app/api/bot/mcp/[id]/token/route";
import { GET as startConnect } from "./app/api/mcp/[id]/connect/route";
import { GET as callback } from "./app/api/mcp/callback/route";

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type FakeTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type FakeOAuthData = {
  state?: string;
  codeVerifier?: string;
  flowStartedAt?: number;
  redirectOrigin?: string;
  tokensIssuedAt?: number;
  tokens?: FakeTokens;
  connectIntent?: { token: string; expiresAt: number };
};

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type FakeConnection = {
  id: string;
  botId: string;
  catalogId: string;
  status: "pending" | "connected" | "error";
  error: string | null;
};

// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type CallbackResult = {
  value: unknown;
  data: FakeOAuthData;
  status?: FakeConnection["status"];
  error?: string | null;
};

type StoreCallback = (
  row: FakeConnection,
  data: FakeOAuthData
) => Promise<CallbackResult>;
// biome-ignore lint/style/useConsistentTypeDefinitions: test fixture type aliases mirror the external data contracts under test.
type FakeProviderLike = { data: FakeOAuthData };

const harness = vi.hoisted(() => {
  class FakeProvider {
    data: FakeOAuthData;
    constructor(data: FakeOAuthData = {}) {
      this.data = {
        ...data,
        tokens: data.tokens ? { ...data.tokens } : undefined,
      };
    }
    invalidateCredentials(scope: string) {
      if (scope === "tokens" || scope === "all") {
        // biome-ignore lint/performance/noDelete: OAuth fake intentionally deletes credentials to model invalidation.
        delete this.data.tokens;
      }
      if (scope === "verifier" || scope === "all") {
        // biome-ignore lint/performance/noDelete: OAuth fake intentionally deletes credentials to model invalidation.
        delete this.data.state;
        // biome-ignore lint/performance/noDelete: OAuth fake intentionally deletes credentials to model invalidation.
        delete this.data.codeVerifier;
        // biome-ignore lint/performance/noDelete: OAuth fake intentionally deletes credentials to model invalidation.
        delete this.data.flowStartedAt;
      }
    }
  }
  class FakeReconnectError extends Error {
    constructor(message = "expired") {
      super(message);
      this.name = "McpReconnectError";
    }
  }

  const jar = {
    delete: vi.fn((input: { name: string }) => jar.values.delete(input.name)),
    get: vi.fn((name: string) => {
      const value = jar.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set: vi.fn((name: string, value: string) => jar.values.set(name, value)),
    values: new Map<string, string>(),
  };
  const cookies = vi.fn(async () => jar);
  const getBot = vi.fn();
  const botFromRequest = vi.fn();
  const withConnection =
    vi.fn<(id: string, run: StoreCallback) => Promise<unknown>>();
  const startOAuth = vi.fn<(provider: FakeProviderLike) => Promise<unknown>>();
  const finishOAuth = vi.fn<(provider: FakeProviderLike) => Promise<unknown>>();
  const freshToken = vi.fn();
  const db = vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(async () => [{ slug: "alpha" }]),
      })),
    })),
  }));
  const providerClass = FakeProvider;
  return {
    botFromRequest,
    cookies,
    db,
    FakeReconnectError,
    finishOAuth,
    freshToken,
    getBot,
    jar,
    providerClass,
    startOAuth,
    withConnection,
  };
});

vi.mock("next/headers", () => ({ cookies: harness.cookies }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@/lib/db", () => ({ bots: { id: {}, slug: {} }, db: harness.db }));
vi.mock("@/lib/bots/service", () => ({ getBot: harness.getBot }));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: harness.botFromRequest }));
vi.mock("@/lib/mcp/store", () => ({ withConnection: harness.withConnection }));
vi.mock("@/lib/mcp/oauth", () => ({
  finishOAuth: harness.finishOAuth,
  freshToken: harness.freshToken,
  McpOAuthProvider: harness.providerClass,
  McpReconnectError: harness.FakeReconnectError,
  startOAuth: harness.startOAuth,
}));

const id = "11111111-1111-4111-8111-111111111111";
const bot = { id: "bot-alpha", slug: "alpha" };
const connection: {
  id: string;
  botId: string;
  catalogId: string;
  status: "pending" | "connected" | "error";
  error: string | null;
} = {
  botId: bot.id,
  catalogId: "linear",
  error: null,
  id,
  status: "pending",
};
const connectParams = { params: Promise.resolve({ id }) };
const tokenParams = { params: Promise.resolve({ id }) };
const callbackUrl = (query: string) =>
  new Request(`https://busy.test/api/mcp/callback?cid=${id}&${query}`);

function locationOf(response: Response) {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected an OAuth redirect location");
  }
  return location;
}
const connectTicket = "connect-ticket";
const validIntent = { expiresAt: Date.now() + 60_000, token: connectTicket };

function installConnectionHarness(
  row: FakeConnection = connection,
  data: FakeOAuthData = {}
) {
  harness.withConnection.mockImplementation(
    async (selectedId: string, run: StoreCallback) => {
      // biome-ignore lint/suspicious/noMisplacedAssertion: callback is invoked from the enclosing test and validates its contract.
      expect(selectedId).toBe(id);
      const result = await run(row, { ...data });
      return result.value;
    }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  harness.jar.values.clear();
  harness.getBot.mockResolvedValue(bot);
  harness.botFromRequest.mockResolvedValue({ slug: bot.slug });
  // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
  harness.startOAuth.mockImplementation(async (provider: FakeProviderLike) => {
    provider.data.state = "csrf-state";
    provider.data.flowStartedAt = Date.now();
    return {
      authorizationUrl: new URL(
        "https://linear.example/authorize?client_id=busy"
      ),
      result: "REDIRECT",
    };
  });
  // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
  harness.finishOAuth.mockImplementation(async (provider: FakeProviderLike) => {
    provider.data.tokens = {
      access_token: "access-secret",
      expires_in: 3600,
      refresh_token: "refresh-secret",
    };
    provider.data.tokensIssuedAt = Date.now();
    return "AUTHORIZED";
  });
  harness.freshToken.mockResolvedValue({
    expiresAt: Date.now() + 3_600_000,
    token: "access-secret",
  });
});

describe("MCP OAuth route security", () => {
  it("starts a flow with a short-lived state cookie and never echoes provider credentials", async () => {
    installConnectionHarness(connection, { connectIntent: validIntent });
    const response = await startConnect(
      new Request(
        `https://busy.test/api/mcp/${id}/connect?ticket=${connectTicket}`,
        {
          // A valid intent ticket authorizes the OAuth handoff even when the
          // provider/browser reports a cross-site navigation.
          headers: { "sec-fetch-site": "cross-site" },
        }
      ),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://linear.example/authorize?client_id=busy"
    );
    expect(harness.jar.set).toHaveBeenCalledWith(
      `busy_mcp_${id}`,
      "csrf-state",
      expect.objectContaining({ httpOnly: true, path: "/api/mcp/callback" })
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("location")).not.toContain("access-secret");
  });

  it("persists a generic error when the provider denies or fails discovery", async () => {
    const results: CallbackResult[] = [];
    harness.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(connection, { connectIntent: validIntent });
        results.push(result);
        return result.value;
      }
    );
    harness.startOAuth.mockRejectedValue(
      new Error("provider code=TOP_SECRET access_token=LEAK")
    );

    const response = await startConnect(
      new Request(
        `https://busy.test/api/mcp/${id}/connect?ticket=${connectTicket}`
      ),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(results[0]).toMatchObject({
      error: "Couldn't start sign-in. Try reconnecting.",
      status: "error",
    });
    expect(JSON.stringify(results[0])).not.toContain("TOP_SECRET");
    expect(JSON.stringify(results[0])).not.toContain("LEAK");
    expect(harness.jar.set).not.toHaveBeenCalled();
  });

  it("rejects connect attempts without the one-time intent ticket", async () => {
    const response = await startConnect(
      new Request("https://busy.test/api/mcp//connect", {
        headers: { "sec-fetch-site": "cross-site" },
      }),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(harness.getBot).not.toHaveBeenCalled();
    expect(harness.withConnection).toHaveBeenCalledOnce();
    expect(harness.startOAuth).not.toHaveBeenCalled();
    expect(harness.jar.set).not.toHaveBeenCalled();
  });

  it("preserves an already connected grant instead of resetting OAuth", async () => {
    installConnectionHarness(
      { ...connection, status: "connected" },
      {
        redirectOrigin: "https://busy.test",
        state: "old-state",
        tokens: {
          access_token: "existing-access",
          refresh_token: "existing-refresh",
        },
      }
    );
    const response = await startConnect(
      new Request("https://busy.test/api/mcp//connect"),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe(
      "connected"
    );
    expect(harness.startOAuth).not.toHaveBeenCalled();
    expect(harness.jar.set).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", { expiresAt: Date.now() - 1, token: connectTicket }],
    [
      "mismatched",
      { expiresAt: Date.now() + 60_000, token: "a-different-ticket" },
    ],
  ])(
    "rejects a %s intent without changing the pending flow",
    async (_reason, intent) => {
      const data = {
        codeVerifier: "keep-verifier",
        connectIntent: intent,
        state: "keep-state",
      };
      installConnectionHarness(connection, data);
      const response = await startConnect(
        new Request(
          `https://busy.test/api/mcp/${id}/connect?ticket=${connectTicket}`
        ),
        connectParams
      );
      expect(new URL(locationOf(response)).pathname).toBe("/");
      expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe(
        "error"
      );
      expect(data.state).toBe("keep-state");
      expect(data.codeVerifier).toBe("keep-verifier");
      expect(harness.startOAuth).not.toHaveBeenCalled();
      expect(harness.jar.set).not.toHaveBeenCalled();
    }
  );

  it("consumes a valid intent so reloading its URL cannot reset the PKCE flow", async () => {
    let persisted: FakeOAuthData = { connectIntent: validIntent };
    harness.withConnection.mockImplementation(async (_selectedId, run) => {
      const result = await run(connection, structuredClone(persisted));
      persisted = result.data;
      return result.value;
    });
    const request = () =>
      new Request(
        `https://busy.test/api/mcp/${id}/connect?ticket=${connectTicket}`
      );
    const first = await startConnect(request(), connectParams);
    expect(first.headers.get("location")).toContain(
      "https://linear.example/authorize"
    );
    expect(persisted.connectIntent).toBeUndefined();
    expect(persisted.state).toBe("csrf-state");
    const replay = await startConnect(request(), connectParams);
    expect(new URL(locationOf(replay)).pathname).toBe("/");
    expect(new URL(locationOf(replay)).searchParams.get("mcp")).toBe("error");
    expect(persisted.state).toBe("csrf-state");
    expect(harness.startOAuth).toHaveBeenCalledOnce();
    expect(harness.jar.set).toHaveBeenCalledOnce();
  });

  it("rejects a callback with no browser cookie or mismatched state", async () => {
    const response = await callback(
      callbackUrl("state=wrong&code=provider-code")
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(harness.withConnection).not.toHaveBeenCalled();

    harness.jar.values.set(`busy_mcp_${id}`, "correct-state");
    const mismatched = await callback(
      callbackUrl("state=wrong&code=provider-code")
    );
    expect(mismatched.status).toBe(303);
    expect(harness.withConnection).not.toHaveBeenCalled();
  });

  it("expires a pending flow without exchanging its authorization code", async () => {
    harness.jar.values.set(`busy_mcp_${id}`, "old-state");
    const expired = { ...connection, status: "pending" as const };
    const results: CallbackResult[] = [];
    harness.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(expired, {
          codeVerifier: "verifier",
          flowStartedAt: Date.now() - 11 * 60 * 1000,
          redirectOrigin: "https://busy.test",
          state: "old-state",
        });
        results.push(result);
        return result.value;
      }
    );

    const response = await callback(
      callbackUrl("state=old-state&code=provider-code")
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(harness.finishOAuth).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      error: "Sign-in expired. Reconnect to try again.",
      status: "error",
    });
    expect(results[0]?.data.state).toBeUndefined();
    expect(results[0]?.data.codeVerifier).toBeUndefined();
    expect(results[0]?.data.flowStartedAt).toBeUndefined();
  });

  it("consumes the state cookie so a successful callback cannot be replayed", async () => {
    harness.jar.values.set(`busy_mcp_${id}`, "csrf-state");
    installConnectionHarness(connection, {
      codeVerifier: "verifier",
      flowStartedAt: Date.now(),
      redirectOrigin: "https://busy.test",
      state: "csrf-state",
    });

    const first = await callback(
      callbackUrl("state=csrf-state&code=provider-code")
    );
    expect(new URL(locationOf(first)).pathname).toBe("/");
    expect(new URL(locationOf(first)).searchParams.get("mcp")).toBe(
      "connected"
    );
    expect(harness.finishOAuth).toHaveBeenCalledOnce();
    expect(harness.jar.delete).toHaveBeenCalledWith({
      name: `busy_mcp_${id}`,
      path: "/api/mcp/callback",
    });

    const second = await callback(
      callbackUrl("state=csrf-state&code=provider-code")
    );
    expect(new URL(locationOf(second)).pathname).toBe("/");
    expect(new URL(locationOf(second)).searchParams.get("mcp")).toBe("error");
    expect(harness.finishOAuth).toHaveBeenCalledOnce();
  });

  it("never reflects provider error details or codes in callback redirects", async () => {
    harness.jar.values.set(`busy_mcp_${id}`, "csrf-state");
    installConnectionHarness(connection, {
      codeVerifier: "verifier",
      flowStartedAt: Date.now(),
      redirectOrigin: "https://busy.test",
      state: "csrf-state",
    });

    const response = await callback(
      callbackUrl(
        "state=csrf-state&error=access_denied&error_description=TOP_SECRET&code=provider-secret"
      )
    );
    const location = locationOf(response);
    expect(location).not.toContain("TOP_SECRET");
    expect(location).not.toContain("provider-secret");
    expect(location).not.toContain("access_denied");
    expect(new URL(location).pathname).toBe("/");
    expect(new URL(location).searchParams.get("mcp")).toBe("error");
  });
});

describe("MCP token broker", () => {
  it("passes the app connection id to the store and returns a no-store token", async () => {
    installConnectionHarness(
      { ...connection, status: "connected" },
      { redirectOrigin: "https://busy.test" }
    );
    const response = await broker(
      new Request("https://busy.test/api/bot/mcp//token"),
      tokenParams
    );
    expect(response.status).toBe(200);
    expect(harness.withConnection).toHaveBeenCalledWith(
      id,
      expect.any(Function)
    );
    expect(await response.json()).toMatchObject({ token: "access-secret" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks terminal expiry as reconnect-required without leaking token errors", async () => {
    const results: CallbackResult[] = [];
    harness.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(
          { ...connection, status: "connected" },
          { redirectOrigin: "https://busy.test" }
        );
        results.push(result);
        return result.value;
      }
    );
    harness.freshToken.mockRejectedValue(
      new harness.FakeReconnectError("refresh_token=TOP_SECRET")
    );

    const response = await broker(
      new Request("https://busy.test/api/bot/mcp//token"),
      tokenParams
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Reconnect this MCP in the marketplace.",
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(results[0]).toMatchObject({
      error: "Authorization expired or was revoked. Reconnect this service.",
      status: "error",
    });
    expect(JSON.stringify(results[0])).not.toContain("TOP_SECRET");
  });

  it("keeps a connected row on transient provider failure and returns 502", async () => {
    const results: CallbackResult[] = [];
    harness.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(
          { ...connection, status: "connected" },
          { redirectOrigin: "https://busy.test" }
        );
        results.push(result);
        return result.value;
      }
    );
    harness.freshToken.mockRejectedValue(new Error("provider outage"));

    const response = await broker(
      new Request("https://busy.test/api/bot/mcp//token"),
      tokenParams
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "MCP authorization is temporarily unavailable.",
    });
    expect(results[0]?.status).toBeUndefined();
    expect(results[0]?.data).toMatchObject({
      redirectOrigin: "https://busy.test",
    });
  });
});
