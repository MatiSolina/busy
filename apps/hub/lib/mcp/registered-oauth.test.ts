import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptOAuth, encryptOAuth } from "./crypto";
import {
  McpOAuthProvider,
  McpOAuthTransientError,
  McpReconnectError,
} from "./oauth";
import {
  finishRegisteredOAuth,
  finishVercelCimdOAuth,
  freshRegisteredToken,
  type RegisteredClient,
  type RegisteredOAuthData,
  registeredCallbackUrl,
  startRegisteredOAuth,
  startVercelCimdOAuth,
  vercelCimdCallbackUrl,
  vercelCimdMetadata,
} from "./registered-oauth";

const providerOptions = {
  connectionId: "connection-registered-1",
  origin: "https://busy.example.com",
};
const client: RegisteredClient = {
  clientId: "client-id",
  clientSecret: "client-secret",
  version: "2026-11-02.1",
};
const lookupFn = async () => [{ address: "93.184.216.34" }];
const oauthWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  oauthWarn.mockClear();
});

afterAll(() => {
  oauthWarn.mockRestore();
});

describe("registered OAuth providers", () => {
  it("uses a fixed callback and allowlisted GitHub endpoints", () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    const started = startRegisteredOAuth(provider, "github", client, {
      scope: "read:user",
    });
    const auth = started.authorizationUrl;
    expect(registeredCallbackUrl(provider.origin, "github")).toBe(
      "https://busy.example.com/api/mcp/oauth/github/callback"
    );
    expect(auth.origin).toBe("https://github.com");
    expect(auth.pathname).toBe("/login/oauth/authorize");
    expect(auth.searchParams.get("client_id")).toBe(client.clientId);
    expect(auth.searchParams.get("redirect_uri")).toBe(
      registeredCallbackUrl(provider.origin, "github")
    );
    expect(auth.searchParams.get("response_type")).toBe("code");
    expect(auth.searchParams.get("scope")).toBe("read:user");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    expect(auth.searchParams.get("code_challenge")).toBeTruthy();
    expect(auth.searchParams.get("state")).toBe(started.state);
    expect(auth.toString()).not.toContain(client.clientSecret);
    expect(provider.data.registeredProvider).toBe("github");
    expect(provider.data.registeredClientVersion).toBe(client.version);
  });

  it("sets Google's offline consent and isolates Gmail and Calendar scopes", () => {
    const gmail = new McpOAuthProvider(
      {},
      { ...providerOptions, connectionId: "gmail-connection" }
    );
    const calendar = new McpOAuthProvider(
      {},
      { ...providerOptions, connectionId: "calendar-connection" }
    );
    const gmailStarted = startRegisteredOAuth(gmail, "google", client, {
      scope: "https://www.googleapis.com/auth/gmail.readonly",
    });
    const calendarStarted = startRegisteredOAuth(calendar, "google", client, {
      scope: "https://www.googleapis.com/auth/calendar.readonly",
    });
    const gmailAuth = gmailStarted.authorizationUrl;
    const calendarAuth = calendarStarted.authorizationUrl;
    expect(gmailAuth.origin).toBe("https://accounts.google.com");
    expect(gmailAuth.pathname).toBe("/o/oauth2/v2/auth");
    expect(gmailAuth.searchParams.get("access_type")).toBe("offline");
    expect(gmailAuth.searchParams.get("prompt")).toBe("consent");
    expect(gmailAuth.searchParams.get("include_granted_scopes")).toBe("false");
    expect(gmailAuth.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly"
    );
    expect(calendarAuth.searchParams.get("include_granted_scopes")).toBe(
      "false"
    );
    expect(calendarAuth.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/calendar.readonly"
    );
    expect(calendarAuth.searchParams.get("scope")).not.toContain("gmail");
    expect(gmailAuth.searchParams.get("scope")).not.toContain("calendar");
    expect(gmailAuth.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("uses Vercel CIMD without DCR and exchanges its PKCE code", async () => {
    vi.stubEnv("HUB_URL", providerOptions.origin);
    try {
      const provider = new McpOAuthProvider(
        {},
        {
          ...providerOptions,
          redirectUrl: vercelCimdCallbackUrl(providerOptions.origin),
        }
      );
      const calls: { init?: RequestInit; url: string }[] = [];
      const authorizationMetadata = {
        authorization_endpoint: "https://vercel.com/oauth/authorize",
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: true,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: "https://vercel.com",
        registration_endpoint: "https://api.vercel.com/login/oauth/register",
        response_types_supported: ["code"],
        scopes_supported: ["openid"],
        token_endpoint: "https://api.vercel.com/login/oauth/token",
        token_endpoint_auth_methods_supported: ["none"],
      };
      let tokenParams: URLSearchParams | null = null;
      const readTokenParams = () => tokenParams;
      const fetchFn = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ init, url });
        if (url.endsWith("/.well-known/oauth-protected-resource")) {
          return Promise.resolve(
            Response.json({
              authorization_servers: ["https://vercel.com"],
              resource: "https://mcp.vercel.com/",
              scopes_supported: ["openid"],
            })
          );
        }
        if (
          url.includes("oauth-authorization-server") ||
          url.includes("openid-configuration")
        ) {
          return Promise.resolve(Response.json(authorizationMetadata));
        }
        if (url === "https://api.vercel.com/login/oauth/token") {
          tokenParams = new URLSearchParams(String(init?.body));
          return Promise.resolve(
            Response.json({
              access_token: "vercel-access",
              expires_in: 3600,
              refresh_token: "vercel-refresh",
              token_type: "bearer",
            })
          );
        }
        if (url.includes("/register")) {
          throw new Error("Vercel CIMD must not call DCR");
        }
        return Promise.resolve(new Response(null, { status: 404 }));
      };

      const started = await startVercelCimdOAuth(
        provider,
        "https://mcp.vercel.com",
        { fetchFn, lookupFn }
      );
      const { authorizationUrl } = started;
      expect(authorizationUrl.searchParams.get("client_id")).toBe(
        vercelCimdMetadata().client_id
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
        vercelCimdCallbackUrl(providerOptions.origin)
      );
      expect(authorizationUrl.searchParams.get("scope")).toBe("openid");
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
        "S256"
      );
      expect(provider.data.cimdProvider).toBe("vercel");

      await expect(
        Promise.resolve().then(() =>
          finishVercelCimdOAuth(
            provider,
            "https://mcp.vercel.com",
            "vercel-code",
            started.state,
            { callbackIssuer: "https://attacker.example", fetchFn, lookupFn }
          )
        )
      ).rejects.toBeInstanceOf(McpReconnectError);
      expect(tokenParams).toBeNull();

      await expect(
        finishVercelCimdOAuth(
          provider,
          "https://mcp.vercel.com",
          "vercel-code",
          started.state,
          {
            callbackIssuer: "https://vercel.com",
            fetchFn,
            lookupFn,
          }
        )
      ).resolves.toBe("AUTHORIZED");
      expect(provider.tokens()).toMatchObject({
        access_token: "vercel-access",
        refresh_token: "vercel-refresh",
      });
      const exchangedParams = readTokenParams();
      expect(exchangedParams?.get("client_id")).toBe(
        vercelCimdMetadata().client_id
      );
      expect(exchangedParams?.get("client_secret")).toBeNull();
      expect(exchangedParams?.get("code")).toBe("vercel-code");
      expect(exchangedParams?.get("code_verifier")).toBeTruthy();
      expect(calls.some((call) => call.url.includes("/register"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("exchanges a GitHub code after a sealed process restart and refreshes it", async () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    const started = startRegisteredOAuth(provider, "github", client);
    const sealed = encryptOAuth<RegisteredOAuthData>(
      provider.data as RegisteredOAuthData,
      provider.connectionId,
      "a sufficiently long test secret"
    );
    const restarted = new McpOAuthProvider(
      decryptOAuth<RegisteredOAuthData>(
        sealed,
        provider.connectionId,
        "a sufficiently long test secret"
      ),
      providerOptions
    );
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn = // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ init, url });
        const params = new URLSearchParams(String(init?.body));
        if (calls.length === 1) {
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(url).toBe("https://github.com/login/oauth/access_token");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("grant_type")).toBe("authorization_code");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("code")).toBe("synthetic-code");
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("client_id")).toBe(client.clientId);
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("client_secret")).toBe(client.clientSecret);
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("redirect_uri")).toBe(
            registeredCallbackUrl(provider.origin, "github")
          );
          // biome-ignore lint/suspicious/noConditionalExpect: This branch asserts the authorization-code request protocol.
          expect(params.get("code_verifier")).toBeTruthy();
          return Response.json({
            access_token: "github-access",
            expires_in: 1,
            refresh_token: "github-refresh",
            token_type: "bearer",
          });
        }
        expect(url).toBe("https://github.com/login/oauth/access_token");
        expect(params.get("grant_type")).toBe("refresh_token");
        expect(params.get("refresh_token")).toBe("github-refresh");
        expect(params.get("client_id")).toBe(client.clientId);
        expect(params.get("client_secret")).toBe(client.clientSecret);
        return Response.json({
          access_token: "github-refreshed",
          expires_in: 3600,
          token_type: "bearer",
        });
      };

    await expect(
      finishRegisteredOAuth(
        restarted,
        "github",
        "synthetic-code",
        started.state,
        { fetchFn, lookupFn }
      )
    ).resolves.toBe("AUTHORIZED");
    expect(restarted.tokens()).toMatchObject({
      access_token: "github-access",
      refresh_token: "github-refresh",
    });
    expect(restarted.data.state).toBeUndefined();
    expect(restarted.data.codeVerifier).toBeUndefined();

    const refreshed = await freshRegisteredToken(
      restarted,
      "github",
      Date.now() + 120_000,
      { fetchFn, lookupFn }
    );
    expect(refreshed.token).toBe("github-refreshed");
    expect(restarted.tokens()).toMatchObject({
      access_token: "github-refreshed",
      refresh_token: "github-refresh",
    });
    expect(calls).toHaveLength(2);
  });

  it("fails closed for a mismatched state or provider binding", async () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    const started = startRegisteredOAuth(provider, "github", client);
    await expect(
      finishRegisteredOAuth(provider, "github", "code", "wrong", { lookupFn })
    ).rejects.toBeInstanceOf(McpReconnectError);
    await expect(
      finishRegisteredOAuth(provider, "google", "code", started.state, {
        lookupFn,
      })
    ).rejects.toBeInstanceOf(McpReconnectError);
  });

  it("does not leak registered client secrets on token endpoint failures", async () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    const started = startRegisteredOAuth(provider, "google", client);
    const fetchFn = async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: `secret ${client.clientSecret}`,
        }),
        {
          headers: { "Content-Type": "application/json" },
          status: 400,
        }
      );
    const result = finishRegisteredOAuth(
      provider,
      "google",
      "code",
      started.state,
      { fetchFn, lookupFn }
    );
    await expect(result).rejects.toBeInstanceOf(McpReconnectError);
    await expect(result).rejects.not.toThrow(client.clientSecret);

    const transientProvider = new McpOAuthProvider({}, providerOptions);
    const transientStarted = startRegisteredOAuth(
      transientProvider,
      "google",
      client
    );
    const transient = finishRegisteredOAuth(
      transientProvider,
      "google",
      "code",
      transientStarted.state,
      {
        fetchFn: async () =>
          new Response(`upstream failed ${client.clientSecret}`, {
            status: 503,
          }),
        lookupFn,
      }
    );
    await expect(transient).rejects.toBeInstanceOf(McpOAuthTransientError);
    await expect(transient).rejects.not.toThrow(client.clientSecret);
  });

  it("treats GitHub's HTTP 200 error payloads as reconnect failures", async () => {
    const provider = new McpOAuthProvider({}, providerOptions);
    const started = startRegisteredOAuth(provider, "github", client);
    const error = finishRegisteredOAuth(
      provider,
      "github",
      "code",
      started.state,
      {
        fetchFn: async () =>
          Response.json(
            {
              error: "bad_refresh_token",
              error_description: "the refresh token is no longer valid",
            },
            { status: 200 }
          ),
        lookupFn,
      }
    );
    await expect(error).rejects.toBeInstanceOf(McpReconnectError);
  });

  it.each([
    "invalid_client",
    "bad_verification_code",
    "redirect_uri_mismatch",
  ] as const)(
    "logs only allowlisted provider error code %s for token exchange failures",
    async (code) => {
      const provider = new McpOAuthProvider({}, providerOptions);
      const started = startRegisteredOAuth(provider, "github", client);
      const result = finishRegisteredOAuth(
        provider,
        "github",
        "code",
        started.state,
        {
          fetchFn: async () =>
            Response.json(
              {
                error: code,
                error_description: "secret token details",
              },
              { status: 400 }
            ),
          lookupFn,
        }
      );

      await expect(result).rejects.toBeInstanceOf(McpReconnectError);
      expect(oauthWarn).toHaveBeenCalledWith("mcp.oauth", {
        category: "provider_error",
        provider: "github",
        providerError: code,
        stage: "token_exchange",
      });
      expect(JSON.stringify(oauthWarn.mock.calls)).not.toContain("secret");
    }
  );
});
