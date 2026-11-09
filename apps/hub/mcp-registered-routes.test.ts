import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as broker } from "./app/api/bot/mcp/[id]/token/route";
import {
  POST as prepareReconnect,
  GET as startConnect,
} from "./app/api/mcp/[id]/connect/route";
import {
  GET as githubCallback,
  GET as googleCallback,
} from "./app/api/mcp/oauth/[provider]/callback/route";

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
  registeredProvider?: "github" | "google";
  registeredClientVersion?: string;
  returnTo?: string;
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
type FakeProviderLike = {
  data: FakeOAuthData;
  invalidateCredentials: (scope: string) => void;
};

const h = vi.hoisted(() => {
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
  const jar = {
    delete: vi.fn((input: { name: string }) => jar.values.delete(input.name)),
    get: vi.fn((name: string) => {
      const value = jar.values.get(name);
      return value === undefined ? undefined : { name, value };
    }),
    set: vi.fn((name: string, value: string) => jar.values.set(name, value)),
    values: new Map<string, string>(),
  };
  return {
    botFromRequest: vi.fn(),
    cookies: vi.fn(async () => jar),
    db: vi.fn(() => ({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(async () => [{ slug: "alpha" }]),
        })),
      })),
    })),
    FakeProvider,
    finishOAuth: vi.fn(),
    finishRegisteredOAuth:
      vi.fn<
        (
          provider: FakeProviderLike,
          providerId: "github" | "google",
          code: string,
          state: string
        ) => Promise<unknown>
      >(),
    freshRegisteredToken: vi.fn(),
    freshToken: vi.fn(),
    getBot: vi.fn(),
    getProviderClient: vi.fn(),
    jar,
    startOAuth: vi.fn(),
    startRegisteredOAuth:
      vi.fn<
        (
          provider: FakeProviderLike,
          providerId: "github" | "google",
          client: unknown,
          options?: { scope?: string }
        ) => { authorizationUrl: URL; state: string }
      >(),
    withConnection:
      vi.fn<(id: string, run: StoreCallback) => Promise<unknown>>(),
  };
});

const oauthWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

vi.mock("next/headers", () => ({ cookies: h.cookies }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@/lib/db", () => ({ bots: { id: {}, slug: {} }, db: h.db }));
vi.mock("@/lib/env", () => ({
  need: (key: string) =>
    key === "HUB_URL"
      ? "https://busy.test"
      : "test-session-secret-which-is-long-enough",
}));
vi.mock("@/lib/bots/service", () => ({ getBot: h.getBot }));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: h.botFromRequest }));
vi.mock("@/lib/mcp/store", () => ({ withConnection: h.withConnection }));
vi.mock("@/lib/mcp/provider-clients", () => ({
  getProviderClient: h.getProviderClient,
  isRegisteredProvider: (provider: string) =>
    provider === "github" || provider === "google",
}));
vi.mock("@/lib/mcp/oauth", () => ({
  finishOAuth: h.finishOAuth,
  freshToken: h.freshToken,
  McpOAuthProvider: h.FakeProvider,
  McpOAuthTransientError: class FakeTransientError extends Error {},
  McpReconnectError: class FakeReconnectError extends Error {},
  startOAuth: h.startOAuth,
}));
vi.mock("@/lib/mcp/registered-oauth", () => ({
  finishRegisteredOAuth: h.finishRegisteredOAuth,
  freshRegisteredToken: h.freshRegisteredToken,
  registeredCallbackUrl: (origin: string, provider: string) =>
    `${origin}/api/mcp/oauth/${provider}/callback`,
  registeredProviderDefinition: (provider: "github" | "google") => ({
    authorizationServerUrl:
      provider === "github"
        ? "https://github.com"
        : "https://accounts.google.com",
    issuer:
      provider === "github"
        ? "https://github.com/login/oauth"
        : "https://accounts.google.com",
  }),
  startRegisteredOAuth: h.startRegisteredOAuth,
}));

const id = "11111111-1111-4111-8111-111111111111";
const bot = { id: "bot-alpha", slug: "alpha" };
const connection: FakeConnection = {
  botId: bot.id,
  catalogId: "github",
  error: null,
  id,
  status: "pending",
};
const ticket = "registered-connect-ticket";
const connectParams = { params: Promise.resolve({ id }) };
const tokenParams = { params: Promise.resolve({ id }) };
const state = `${id}.registered-nonce`;
const intentData: FakeOAuthData = {
  connectIntent: { expiresAt: Date.now() + 60_000, token: ticket },
};
const callbackRequest = (
  provider: string,
  query = `state=${encodeURIComponent(state)}&code=auth-code`
) =>
  new Request(`https://busy.test/api/mcp/oauth/${provider}/callback?${query}`);

function locationOf(response: Response) {
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("Expected an OAuth redirect location");
  }
  return location;
}

function installConnection(
  row: FakeConnection = connection,
  data: FakeOAuthData = {}
) {
  h.withConnection.mockImplementation(
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
  oauthWarn.mockClear();
  h.jar.values.clear();
  h.getBot.mockResolvedValue(bot);
  h.botFromRequest.mockResolvedValue({ slug: bot.slug });
  h.getProviderClient.mockResolvedValue({
    clientId: "github-client",
    clientSecret: "github-secret",
    version: "github-v1",
  });
  h.startRegisteredOAuth.mockImplementation(
    (provider: FakeProviderLike, providerId: "github" | "google") => {
      provider.data.state = state;
      provider.data.flowStartedAt = Date.now();
      provider.data.registeredProvider = providerId;
      provider.data.registeredClientVersion = "github-v1";
      return {
        authorizationUrl: new URL(
          `https://${providerId}.example/authorize?client_id=registered`
        ),
        state,
      };
    }
  );
  h.finishRegisteredOAuth.mockImplementation(
    // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
    async (provider: FakeProviderLike) => {
      provider.data.tokens = {
        access_token: "registered-access",
        expires_in: 3600,
        refresh_token: "registered-refresh",
      };
      return "AUTHORIZED";
    }
  );
  h.freshRegisteredToken.mockResolvedValue({
    expiresAt: Date.now() + 3_600_000,
    token: "registered-access",
  });
});

describe("registered-provider connect flow", () => {
  it("issues a reconnect ticket without returning or clearing the existing grant", async () => {
    let result: CallbackResult | undefined;
    h.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        result = await run(
          { ...connection, status: "connected" },
          {
            codeVerifier: "old-verifier",
            flowStartedAt: Date.now(),
            redirectOrigin: "https://busy.test",
            returnTo: "/b/old",
            state: "old-state",
            tokens: {
              access_token: "existing-access",
              refresh_token: "existing-refresh",
            },
          }
        );
        return result.value;
      }
    );

    const response = await prepareReconnect(
      new Request(`https://busy.test/api/mcp/${id}/connect`, {
        method: "POST",
      }),
      connectParams
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { connectUrl?: unknown };
    expect(body.connectUrl).toEqual(
      expect.stringMatching(
        new RegExp(`^/api/mcp/${id}/connect\\?ticket=.+$`, "u")
      )
    );
    expect(result?.status).toBe("pending");
    expect(result?.data.tokens).toEqual({
      access_token: "existing-access",
      refresh_token: "existing-refresh",
    });
    expect(result?.data.codeVerifier).toBeUndefined();
    expect(result?.data.flowStartedAt).toBeUndefined();
    expect(result?.data.returnTo).toBeUndefined();
    expect(result?.data.state).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("existing-access");
    expect(JSON.stringify(body)).not.toContain("existing-refresh");
    expect(h.getProviderClient).toHaveBeenCalledWith("github");
  });

  it("lets the existing GET flow consume the ticket and reset the grant", async () => {
    let persistedRow: FakeConnection = { ...connection, status: "connected" };
    let persistedData: FakeOAuthData = {
      redirectOrigin: "https://busy.test",
      tokens: {
        access_token: "existing-access",
        refresh_token: "existing-refresh",
      },
    };
    h.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(persistedRow, { ...persistedData });
        persistedData = result.data;
        if (result.status) {
          persistedRow = { ...persistedRow, status: result.status };
        }
        return result.value;
      }
    );

    const prepared = await prepareReconnect(
      new Request(`https://busy.test/api/mcp/${id}/connect`, {
        method: "POST",
      }),
      connectParams
    );
    const { connectUrl } = (await prepared.json()) as { connectUrl: string };
    const response = await startConnect(
      new Request(`https://busy.test${connectUrl}`),
      connectParams
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
      "https://github.example/authorize"
    );
    expect(persistedRow.status).toBe("pending");
    expect(persistedData.connectIntent).toBeUndefined();
    expect(persistedData.tokens).toBeUndefined();
  });

  it("rejects a callback carrying state from before an explicit reconnect", async () => {
    let persistedRow: FakeConnection = { ...connection, status: "connected" };
    let persistedData: FakeOAuthData = {
      codeVerifier: "old-verifier",
      flowStartedAt: Date.now(),
      redirectOrigin: "https://busy.test",
      state,
      tokens: { access_token: "existing-access" },
    };
    h.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(persistedRow, { ...persistedData });
        persistedData = result.data;
        if (result.status) {
          persistedRow = { ...persistedRow, status: result.status };
        }
        return result.value;
      }
    );
    h.jar.values.set(`busy_mcp_${id}`, state);

    await prepareReconnect(
      new Request(`https://busy.test/api/mcp/${id}/connect`, {
        method: "POST",
      }),
      connectParams
    );
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });

    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("does not issue a reconnect ticket for a non-GitHub registered connection", async () => {
    installConnection({ ...connection, catalogId: "gmail" }, {});
    const response = await prepareReconnect(
      new Request(`https://busy.test/api/mcp/${id}/connect`, {
        method: "POST",
      }),
      connectParams
    );

    expect(response.status).toBe(404);
    expect(h.getProviderClient).not.toHaveBeenCalled();
  });

  it("rejects a reconnect request from outside the configured hub origin", async () => {
    installConnection({ ...connection, status: "connected" }, {});
    const response = await prepareReconnect(
      new Request(`https://evil.test/api/mcp/${id}/connect`, {
        method: "POST",
      }),
      connectParams
    );

    expect(response.status).toBe(404);
    expect(h.getProviderClient).not.toHaveBeenCalled();
  });

  it("stores a validated chat return destination in the encrypted OAuth flow", async () => {
    let savedData: FakeOAuthData | undefined;
    h.withConnection.mockImplementation(
      async (_selectedId: string, run: StoreCallback) => {
        const result = await run(connection, { ...intentData });
        savedData = result.data;
        return result.value;
      }
    );
    const response = await startConnect(
      new Request(
        `https://busy.test/api/mcp/${id}/connect?ticket=${ticket}&returnTo=%2Fb%2Falpha`
      ),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(savedData?.returnTo).toBe("/b/alpha");
  });

  it("rejects an unsafe return destination without starting OAuth", async () => {
    const response = await startConnect(
      new Request(
        `https://busy.test/api/mcp/${id}/connect?ticket=${ticket}&returnTo=${encodeURIComponent("https://evil.test/b/alpha")}`
      ),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.withConnection).not.toHaveBeenCalled();
    expect(h.startRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("starts GitHub OAuth with the registered client and provider callback cookie path", async () => {
    installConnection(connection, intentData);
    const response = await startConnect(
      new Request(`https://busy.test/api/mcp/${id}/connect?ticket=${ticket}`),
      connectParams
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://github.example/authorize?client_id=registered"
    );
    expect(h.startRegisteredOAuth).toHaveBeenCalledWith(
      expect.anything(),
      "github",
      expect.objectContaining({ clientId: "github-client" }),
      expect.anything()
    );
    expect(h.startOAuth).not.toHaveBeenCalled();
    expect(h.jar.set).toHaveBeenCalledWith(
      `busy_mcp_${id}`,
      state,
      expect.objectContaining({
        httpOnly: true,
        path: "/api/mcp/oauth/github/callback",
      })
    );
  });

  it("passes the registered provider to the token broker and never uses DCR", async () => {
    installConnection(
      { ...connection, status: "connected" },
      {
        redirectOrigin: "https://busy.test",
        registeredClientVersion: "github-v1",
        registeredProvider: "github",
      }
    );
    const response = await broker(
      new Request(`https://busy.test/api/bot/mcp/${id}/token`),
      tokenParams
    );
    expect(response.status).toBe(200);
    expect(h.withConnection).toHaveBeenCalledWith(id, expect.any(Function));
    expect(h.freshRegisteredToken).toHaveBeenCalledWith(
      expect.anything(),
      "github"
    );
    expect(h.freshToken).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ token: "registered-access" });
  });
});

describe("registered-provider callbacks", () => {
  const callbackData: FakeOAuthData = {
    codeVerifier: "verifier",
    flowStartedAt: Date.now(),
    redirectOrigin: "https://busy.test",
    registeredClientVersion: "github-v1",
    registeredProvider: "github",
    state,
  };

  it("completes GitHub callback, consumes its provider-specific cookie, and redirects to the app", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe(
      "connected"
    );
    expect(h.finishRegisteredOAuth).toHaveBeenCalledWith(
      expect.anything(),
      "github",
      "auth-code",
      state
    );
    expect(h.jar.delete).toHaveBeenCalledWith({
      name: `busy_mcp_${id}`,
      path: "/api/mcp/oauth/github/callback",
    });
  });

  it("accepts GitHub's canonical authorization-server issuer", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const response = await githubCallback(
      callbackRequest(
        "github",
        "state=" +
          encodeURIComponent(state) +
          "&code=auth-code&iss=" +
          encodeURIComponent("https://github.com/login/oauth")
      ),
      {
        params: Promise.resolve({ provider: "github" }),
      }
    );

    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe(
      "connected"
    );
    expect(h.finishRegisteredOAuth).toHaveBeenCalledWith(
      expect.anything(),
      "github",
      "auth-code",
      state
    );
  });

  it("accepts a callback that omits the optional issuer parameter", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });

    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe(
      "connected"
    );
    expect(h.finishRegisteredOAuth).toHaveBeenCalledOnce();
  });

  it("returns to the originating bot chat without the marketplace query on success", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, { ...callbackData, returnTo: "/b/alpha" });
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    const location = new URL(locationOf(response));
    expect(location.pathname).toBe("/b/alpha");
    expect(location.search).toBe("");
  });

  it("returns a contextual setup error without provider details", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, { ...callbackData, returnTo: "/b/alpha" });
    h.finishRegisteredOAuth.mockRejectedValueOnce(
      new Error("provider code=secret access_token=hidden")
    );
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    const location = new URL(locationOf(response));
    expect(location.pathname).toBe("/b/alpha");
    expect(location.searchParams.get("codeSetup")).toBe("error");
    expect(location.searchParams.get("mcp")).toBeNull();
    expect(location.toString()).not.toContain("secret");
    expect(location.toString()).not.toContain("hidden");
    expect(oauthWarn).toHaveBeenCalledTimes(1);
    expect(oauthWarn).toHaveBeenCalledWith("mcp.oauth", {
      category: "exchange_failed",
      provider: "github",
      stage: "token_exchange",
    });
    expect(JSON.stringify(oauthWarn.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(oauthWarn.mock.calls)).not.toContain("hidden");
  });

  it("rejects a callback with no cookie/state and does not exchange a code", async () => {
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(response.status).toBe(303);
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.withConnection).not.toHaveBeenCalled();
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("rejects a callback from an alternate host before reading its cookie or database", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    const response = await githubCallback(
      new Request(
        `https://evil.test/api/mcp/oauth/github/callback?state=${encodeURIComponent(state)}&code=auth-code`
      ),
      { params: Promise.resolve({ provider: "github" }) }
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Open OAuth from the configured Busy hub.",
    });
    expect(h.jar.get).not.toHaveBeenCalled();
    expect(h.withConnection).not.toHaveBeenCalled();
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("rejects a provider mixup and uses the attempted provider's cookie path", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const response = await googleCallback(callbackRequest("google"), {
      params: Promise.resolve({ provider: "google" }),
    });
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
    expect(h.jar.delete).toHaveBeenCalledWith({
      name: `busy_mcp_${id}`,
      path: "/api/mcp/oauth/google/callback",
    });
  });

  it("rejects an issuer from the wrong authorization server", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const response = await githubCallback(
      callbackRequest(
        "github",
        `state=${encodeURIComponent(state)}&code=auth-code&iss=https%3A%2F%2Faccounts.google.com`
      ),
      {
        params: Promise.resolve({ provider: "github" }),
      }
    );
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("rejects a callback after the registered client version rotated", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, {
      ...callbackData,
      registeredClientVersion: "stale-version",
    });
    const response = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(new URL(locationOf(response)).pathname).toBe("/");
    expect(new URL(locationOf(response)).searchParams.get("mcp")).toBe("error");
    expect(h.finishRegisteredOAuth).not.toHaveBeenCalled();
  });

  it("consumes callback state so a replay cannot exchange again", async () => {
    h.jar.values.set(`busy_mcp_${id}`, state);
    installConnection(connection, callbackData);
    const first = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(new URL(locationOf(first)).pathname).toBe("/");
    expect(new URL(locationOf(first)).searchParams.get("mcp")).toBe(
      "connected"
    );
    const second = await githubCallback(callbackRequest("github"), {
      params: Promise.resolve({ provider: "github" }),
    });
    expect(new URL(locationOf(second)).pathname).toBe("/");
    expect(new URL(locationOf(second)).searchParams.get("mcp")).toBe("error");
    expect(h.finishRegisteredOAuth).toHaveBeenCalledOnce();
  });

  it("rejects a broker token after the registered client version rotated", async () => {
    installConnection(
      { ...connection, status: "connected" },
      {
        redirectOrigin: "https://busy.test",
        registeredClientVersion: "stale-version",
        registeredProvider: "github",
      }
    );
    const response = await broker(
      new Request(`https://busy.test/api/bot/mcp/${id}/token`),
      tokenParams
    );
    expect(response.status).toBe(409);
    expect(h.freshRegisteredToken).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: "Reconnect this MCP in the marketplace.",
    });
  });
});

afterAll(() => {
  oauthWarn.mockRestore();
});
