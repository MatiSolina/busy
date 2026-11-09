import { describe, expect, it, vi } from "vitest";
import { decryptOAuth, encryptOAuth } from "./crypto";
import {
  finishOAuth,
  freshToken,
  McpOAuthProvider,
  McpReconnectError,
  startOAuth,
} from "./oauth";

const providerOptions = {
  connectionId: "connection-1",
  origin: "https://busy.example.com",
};

describe("MCP OAuth provider", () => {
  it("rejects an HTTP callback origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(
        () =>
          new McpOAuthProvider(
            {},
            { ...providerOptions, origin: "http://busy.example.com" }
          )
      ).toThrow("OAuth redirect origin is invalid");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses a fixed callback URI and persists state, PKCE and server metadata", () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    expect(provider.redirectUrl).toBe(
      "https://busy.example.com/api/mcp/callback?cid=connection-1"
    );
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none");
    const state = provider.state();
    provider.saveState(state);
    provider.saveCodeVerifier("verifier");
    expect(provider.storedState()).toBe(state);
    expect(provider.codeVerifier()).toBe("verifier");
  });

  it("rehydrates Vercel CIMD data with its fixed callback", () => {
    vi.stubEnv("HUB_URL", providerOptions.origin);
    try {
      const data = { cimdProvider: "vercel" as const };
      const provider = new McpOAuthProvider(data, providerOptions);
      expect(provider.redirectUrl).toBe(
        "https://busy.example.com/api/mcp/oauth/vercel/callback"
      );
      expect(provider.clientMetadata.redirect_uris).toEqual([
        provider.redirectUrl,
      ]);
      expect(
        () =>
          new McpOAuthProvider(data, {
            ...providerOptions,
            redirectUrl:
              "https://busy.example.com/api/mcp/callback?cid=connection-1",
          })
      ).toThrow("OAuth redirect URL conflicts with the CIMD provider");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("completes a synthetic DCR + PKCE roundtrip across a process restart", async () => {
    const serverUrl = "https://mcp.example/mcp";
    const provider = new McpOAuthProvider({}, providerOptions);
    const lookupFn = async () => [{ address: "93.184.216.34" }];
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ init, url });
        if (url.includes("oauth-protected-resource")) {
          return new Response(null, { status: 404 });
        }
        if (url.endsWith("/.well-known/oauth-authorization-server/mcp")) {
          return Response.json({
            authorization_endpoint: "https://mcp.example/authorize",
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            issuer: serverUrl,
            registration_endpoint: "https://mcp.example/register",
            response_types_supported: ["code"],
            token_endpoint: "https://mcp.example/token",
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url === "https://mcp.example/register") {
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the DCR request protocol.
          expect(init?.method).toBe("POST");
          const registration = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the DCR request protocol.
          expect(registration.redirect_uris).toEqual([provider.redirectUrl]);
          return Response.json({
            ...registration,
            client_id: "client-1",
          });
        }
        if (url === "https://mcp.example/token") {
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the token request protocol.
          expect(init?.method).toBe("POST");
          const params = new URLSearchParams(String(init?.body));
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the token request protocol.
          expect(params.get("grant_type")).toBe("authorization_code");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the token request protocol.
          expect(params.get("code")).toBe("synthetic-code");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the token request protocol.
          expect(params.get("code_verifier")).toBe(provider.data.codeVerifier);
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the token request protocol.
          expect(params.get("redirect_uri")).toBe(provider.redirectUrl);
          return Response.json({
            access_token: "access",
            expires_in: 3600,
            refresh_token: "refresh",
            token_type: "bearer",
          });
        }
        return new Response(null, { status: 404 });
      };

    const start = await startOAuth(provider, serverUrl, { fetchFn, lookupFn });
    expect(start.result).toBe("REDIRECT");
    expect(start.authorizationUrl).toBeInstanceOf(URL);
    if (!(start.authorizationUrl instanceof URL)) {
      throw new Error("Expected OAuth redirect URL");
    }
    const authorize = start.authorizationUrl;
    const state = authorize.searchParams.get("state");
    expect(state).toBe(provider.data.state);
    expect(authorize.searchParams.get("client_id")).toBe("client-1");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("code_challenge")).toBeTruthy();
    expect(authorize.searchParams.get("redirect_uri")).toBe(
      provider.redirectUrl
    );
    expect(provider.data.codeVerifier).toBeTruthy();

    // The callback may run after a restart; only the sealed provider snapshot
    // crosses the process boundary.
    const sealed = encryptOAuth(
      provider.data,
      providerOptions.connectionId,
      "a sufficiently long test secret"
    );
    const restarted = new McpOAuthProvider(
      decryptOAuth<typeof provider.data>(
        sealed,
        providerOptions.connectionId,
        "a sufficiently long test secret"
      ),
      providerOptions
    );
    await expect(
      finishOAuth(restarted, serverUrl, "synthetic-code", state ?? "", {
        fetchFn,
        lookupFn,
      })
    ).resolves.toBe("AUTHORIZED");
    expect(restarted.tokens()).toMatchObject({
      access_token: "access",
      refresh_token: "refresh",
    });
    expect(restarted.data.state).toBeUndefined();
    expect(restarted.data.codeVerifier).toBeUndefined();
    expect(
      calls.filter((call) => call.url === "https://mcp.example/token")
    ).toHaveLength(1);
  });

  it("fails closed on a callback with a missing or mismatched state", async () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    provider.saveState("expected");
    await expect(
      finishOAuth(provider, "https://mcp.example/mcp", "code", "wrong", {
        lookupFn: async () => [{ address: "93.184.216.34" }],
      })
    ).rejects.toBeInstanceOf(McpReconnectError);
  });

  it("returns a usable non-expiring token without making a network call", async () => {
    const provider = new McpOAuthProvider(
      {
        tokens: {
          access_token: "access",
          refresh_token: "refresh",
          token_type: "bearer",
        },
      },
      providerOptions
    );
    await expect(
      freshToken(provider, "https://mcp.example/mcp")
    ).resolves.toEqual({ token: "access" });
  });

  it("requires reconnect when an expiring token has no refresh token", async () => {
    const provider = new McpOAuthProvider(
      {
        tokens: {
          access_token: "access",
          expires_in: 60,
          token_type: "bearer",
        },
        tokensIssuedAt: 0,
      },
      providerOptions
    );
    await expect(
      freshToken(provider, "https://mcp.example/mcp", 120_000)
    ).rejects.toBeInstanceOf(McpReconnectError);
  });

  it("preserves a refresh token when a provider rotates only the access token", () => {
    const provider = new McpOAuthProvider(
      {
        tokens: {
          access_token: "old",
          expires_in: 1,
          refresh_token: "keep",
          token_type: "bearer",
        },
      },
      providerOptions
    );
    provider.saveTokens({
      access_token: "new",
      expires_in: 3600,
      token_type: "bearer",
    });
    expect(provider.tokens()).toMatchObject({
      access_token: "new",
      refresh_token: "keep",
    });
  });

  it("refreshes an expired token and keeps the old refresh token when omitted", async () => {
    const provider = new McpOAuthProvider(
      {
        clientInformation: { client_id: "client-1" },
        serverInformation: {
          authorizationServerUrl: "https://mcp.example/mcp",
          tokenEndpoint: "https://mcp.example/token",
        },
        tokens: {
          access_token: "old",
          expires_in: 1,
          refresh_token: "keep",
          token_type: "bearer",
        },
        tokensIssuedAt: 0,
      },
      providerOptions
    );
    const calls: string[] = [];
    const fetchFn = // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("oauth-protected-resource")) {
          return new Response(null, { status: 404 });
        }
        if (url.includes("oauth-authorization-server/mcp")) {
          return Response.json({
            authorization_endpoint: "https://mcp.example/authorize",
            code_challenge_methods_supported: ["S256"],
            grant_types_supported: ["refresh_token"],
            issuer: "https://mcp.example/mcp",
            response_types_supported: ["code"],
            token_endpoint: "https://mcp.example/token",
            token_endpoint_auth_methods_supported: ["none"],
          });
        }
        if (url === "https://mcp.example/token") {
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the refresh request protocol.
          expect(init?.method).toBe("POST");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the refresh request protocol.
          expect(String(init?.body)).toContain("refresh_token=keep");
          return Response.json({
            access_token: "new",
            expires_in: 3600,
            token_type: "bearer",
          });
        }
        return new Response(null, { status: 404 });
      };
    const result = await freshToken(
      provider,
      "https://mcp.example/mcp",
      120_000,
      {
        fetchFn,
        lookupFn: async () => [{ address: "93.184.216.34" }],
      }
    );
    expect(result.token).toBe("new");
    expect(provider.tokens()).toMatchObject({
      access_token: "new",
      refresh_token: "keep",
    });
    expect(calls).toContain("https://mcp.example/token");
  });

  it("refreshes rehydrated Vercel CIMD credentials without DCR and fails closed on invalid_grant", async () => {
    vi.stubEnv("HUB_URL", providerOptions.origin);
    try {
      const clientId = "https://busy.example.com/.well-known/busy-mcp-client";
      const clientInformation = {
        authorization_server: "https://vercel.com",
        client_id: clientId,
        issuer: "https://vercel.com",
        token_endpoint: "https://api.vercel.com/login/oauth/token",
      };
      const serverInformation = {
        authorizationServerUrl: "https://vercel.com",
        issuer: "https://vercel.com",
        tokenEndpoint: "https://api.vercel.com/login/oauth/token",
      };
      const authorizationMetadata = {
        authorization_endpoint: "https://vercel.com/oauth/authorize",
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: "https://vercel.com",
        registration_endpoint: "https://api.vercel.com/login/oauth/register",
        response_types_supported: ["code"],
        scopes_supported: ["openid"],
        token_endpoint: "https://api.vercel.com/login/oauth/token",
        token_endpoint_auth_methods_supported: ["none"],
      };
      const baseData = {
        cimdProvider: "vercel" as const,
        clientInformation,
        serverInformation,
        tokens: {
          access_token: "old",
          expires_in: 1,
          refresh_token: "refresh",
          token_type: "bearer",
        },
        tokensIssuedAt: 0,
      };
      const lookupFn = async () => [{ address: "93.184.216.34" }];
      const refreshCalls: string[] = [];
      // biome-ignore lint/suspicious/useAwait: Fetch doubles preserve the async FetchFunction contract.
      const fetchRefresh = async (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => {
        const url = String(input);
        refreshCalls.push(url);
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return Response.json({
            authorization_servers: ["https://vercel.com"],
            resource: "https://mcp.vercel.com/",
            scopes_supported: ["openid"],
          });
        }
        if (
          url === "https://vercel.com/.well-known/oauth-authorization-server"
        ) {
          return Response.json(authorizationMetadata);
        }
        if (url === "https://api.vercel.com/login/oauth/token") {
          const params = new URLSearchParams(String(init?.body));
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the refresh request protocol.
          expect(params.get("grant_type")).toBe("refresh_token");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the refresh request protocol.
          expect(params.get("client_id")).toBe(clientId);
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the refresh request protocol.
          expect(params.get("client_secret")).toBeNull();
          return Response.json({
            access_token: "new",
            expires_in: 3600,
            token_type: "bearer",
          });
        }
        if (url.includes("/register")) {
          throw new Error("Vercel CIMD must not call DCR");
        }
        return new Response(null, { status: 404 });
      };
      const provider = new McpOAuthProvider(baseData, providerOptions);
      await expect(
        freshToken(provider, "https://mcp.vercel.com", 120_000, {
          fetchFn: fetchRefresh,
          lookupFn,
        })
      ).resolves.toMatchObject({ token: "new" });
      expect(provider.redirectUrl).toBe(
        "https://busy.example.com/api/mcp/oauth/vercel/callback"
      );
      expect(refreshCalls.some((url) => url.includes("/register"))).toBe(false);

      const invalidCalls: string[] = [];
      // biome-ignore lint/suspicious/useAwait: Fetch doubles preserve the async FetchFunction contract.
      const fetchInvalid = async (input: RequestInfo | URL) => {
        const url = String(input);
        invalidCalls.push(url);
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return Response.json({
            authorization_servers: ["https://vercel.com"],
            resource: "https://mcp.vercel.com/",
            scopes_supported: ["openid"],
          });
        }
        if (
          url === "https://vercel.com/.well-known/oauth-authorization-server"
        ) {
          return Response.json(authorizationMetadata);
        }
        if (url === "https://api.vercel.com/login/oauth/token") {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        if (url.includes("/register")) {
          throw new Error("Vercel CIMD must not call DCR");
        }
        return new Response(null, { status: 404 });
      };
      const invalidProvider = new McpOAuthProvider(baseData, providerOptions);
      await expect(
        freshToken(invalidProvider, "https://mcp.vercel.com", 120_000, {
          fetchFn: fetchInvalid,
          lookupFn,
        })
      ).rejects.toBeInstanceOf(McpReconnectError);
      expect(
        invalidProvider.pendingAuthorizationUrl?.searchParams.get(
          "redirect_uri"
        )
      ).toBe(invalidProvider.redirectUrl);
      expect(invalidCalls.some((url) => url.includes("/register"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
