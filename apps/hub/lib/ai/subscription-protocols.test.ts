import { generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  finishSubscriptionAuth,
  listSubscriptionModels,
  refreshSubscriptionCredentials,
  startSubscriptionAuth,
} from "./subscription-protocols";
import type { SubscriptionCredentials } from "./subscription-types";

const discovery = {
  authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
  device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
  issuer: "https://auth.x.ai",
  token_endpoint: "https://auth.x.ai/oauth2/token",
  userinfo_endpoint: "https://auth.x.ai/oauth2/userinfo",
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function routeFetch(
  routes: Record<string, Response | (() => Response | Promise<Response>)>
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ init, url });
    const route = routes[url];
    if (!route) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(
      typeof route === "function" ? route() : route.clone()
    );
  };
  return { calls, fetch };
}

async function signedIdToken({
  audience = "oaiapp_test",
  expiresAt,
  includeExpiry = true,
  issuer = "https://auth.openai.com",
  nonce = "nonce",
  privateKey,
}: {
  audience?: string;
  expiresAt?: number;
  includeExpiry?: boolean;
  issuer?: string;
  nonce?: string;
  privateKey?: ReturnType<typeof generateKeyPairSync>["privateKey"];
} = {}) {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const signingKey = privateKey ?? keys.privateKey;
  const publicJwk = await exportJWK(keys.publicKey);
  publicJwk.kid = "test-key";
  let token = new SignJWT({ nonce, sub: "openai-account" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(issuer)
    .setAudience(audience);
  if (includeExpiry) {
    token = token.setExpirationTime(
      expiresAt ?? Math.floor(Date.now() / 1000) + 300
    );
  }
  return {
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
    token: await token.sign(signingKey),
  };
}

describe("subscription OAuth protocols", () => {
  it("starts ChatGPT with PKCE, nonce, plan scope and the stable host id", async () => {
    const started = await startSubscriptionAuth("chatgpt", "urn:uuid:host-1", {
      env: { BUSY_CHATGPT_CLIENT_ID: "oaiapp_test" },
      now: 1000,
    });
    const url = new URL(started.public.url);

    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/api/accounts/authorize");
    expect(url.searchParams.get("client_id")).toBe("oaiapp_test");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:1455/auth/callback"
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBe(started.attempt.nonce);
    expect(url.searchParams.get("state")).toBe(started.attempt.state);
    expect(url.searchParams.get("ext_agent_host_id")).toBe("urn:uuid:host-1");
    expect(url.searchParams.get("scope")).toContain(
      "chatgpt.tokens.use.direct"
    );
    expect(started.public.kind).toBe("browser");
  });

  it("uses the configured client id from the server environment when no test env is passed", async () => {
    process.env.BUSY_CHATGPT_CLIENT_ID = "oaiapp_from_env";
    try {
      const started = await startSubscriptionAuth("chatgpt", "host-1", {
        now: 1000,
      });
      expect(new URL(started.public.url).searchParams.get("client_id")).toBe(
        "oaiapp_from_env"
      );
    } finally {
      delete process.env.BUSY_CHATGPT_CLIENT_ID;
    }
  });

  it("finishes ChatGPT only when the callback, client, scope and identity all match", async () => {
    const started = await startSubscriptionAuth("chatgpt", "host-1", {
      env: { BUSY_CHATGPT_CLIENT_ID: "oaiapp_test" },
      now: 1000,
    });
    const {
      attempt: { state },
    } = started;
    if (!state) {
      throw new Error("test setup did not create state");
    }
    const { calls, fetch } = routeFetch({
      "https://auth.openai.com/api/accounts/oauth/token": () =>
        json({
          access_token: "openai-access",
          client_id: "oaiapp_test",
          expires_in: 3600,
          id_token: "synthetic-id-token",
          refresh_token: "openai-refresh",
          scope:
            "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
        }),
    });
    const credentials = await finishSubscriptionAuth(
      started.attempt,
      `http://127.0.0.1:1455/auth/callback?code=code-1&client_id=oaiapp_test&state=${encodeURIComponent(state)}`,
      {
        fetch,
        now: 1000,
        verifyIdToken: async (_token, context) => ({
          nonce: context.nonce,
          sub: "openai-account",
        }),
      }
    );

    expect(credentials).toMatchObject({
      accessToken: "openai-access",
      accountId: "openai-account",
      clientId: "oaiapp_test",
      refreshToken: "openai-refresh",
    });
    const body = new URLSearchParams(String(calls[0]?.init?.body));
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe(started.attempt.verifier);
    expect(body.get("resource")).toBe("https://api.openai.com/v1");
  });

  it("rejects a ChatGPT callback from another origin or without plan scope", async () => {
    const started = await startSubscriptionAuth("chatgpt", "host-1", {
      now: 1000,
    });
    await expect(
      finishSubscriptionAuth(
        started.attempt,
        "https://evil.example/auth/callback?code=x&state=y",
        { now: 1000 }
      )
    ).rejects.toThrow("callback is invalid");
  });

  it.each([
    ["invalid nonce", { nonce: "wrong" }, "another sign-in"],
    ["invalid issuer", { issuer: "https://evil.example" }, "invalid identity"],
    ["invalid audience", { audience: "other-client" }, "another client"],
    ["expired token", { expiresAt: 900 }, "invalid identity"],
    ["missing expiry", { includeExpiry: false }, "invalid identity"],
  ])("rejects ChatGPT JWTs with %s", async (_label, tokenOptions, message) => {
    const jwtOptions = tokenOptions as {
      audience?: string;
      expiresAt?: number;
      includeExpiry?: boolean;
      issuer?: string;
      nonce?: string;
    };
    const now = 1_700_000_000_000;
    const started = await startSubscriptionAuth("chatgpt", "host-1", {
      env: { BUSY_CHATGPT_CLIENT_ID: "oaiapp_test" },
      now,
    });
    const {
      attempt: { nonce, state },
    } = started;
    if (!(state && nonce)) {
      throw new Error("test setup did not create OAuth state");
    }
    const { token, jwks } = await signedIdToken({
      ...jwtOptions,
      expiresAt:
        typeof jwtOptions.expiresAt === "number"
          ? jwtOptions.expiresAt
          : Math.floor(now / 1000) + 300,
      nonce: jwtOptions.nonce ?? nonce,
    });
    const { fetch } = routeFetch({
      "https://auth.openai.com/api/accounts/oauth/token": json({
        access_token: "access",
        client_id: "oaiapp_test",
        expires_in: 3600,
        id_token: token,
        refresh_token: "refresh",
        scope: "chatgpt.tokens.use.direct",
      }),
    });
    await expect(
      finishSubscriptionAuth(
        started.attempt,
        `http://127.0.0.1:1455/auth/callback?code=code&client_id=oaiapp_test&state=${encodeURIComponent(state)}`,
        { fetch, jwks, now }
      )
    ).rejects.toThrow(message);
  });

  it("rejects a ChatGPT JWT with an invalid signature", async () => {
    const now = 1_700_000_000_000;
    const started = await startSubscriptionAuth("chatgpt", "host-1", {
      env: { BUSY_CHATGPT_CLIENT_ID: "oaiapp_test" },
      now,
    });
    const {
      attempt: { nonce, state },
    } = started;
    if (!(state && nonce)) {
      throw new Error("test setup did not create OAuth state");
    }
    const trusted = await signedIdToken({
      expiresAt: Math.floor(now / 1000) + 300,
      nonce,
    });
    const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { token } = await signedIdToken({
      expiresAt: Math.floor(now / 1000) + 300,
      nonce,
      privateKey: foreign.privateKey,
    });
    const { fetch } = routeFetch({
      "https://auth.openai.com/api/accounts/oauth/token": json({
        access_token: "access",
        client_id: "oaiapp_test",
        expires_in: 3600,
        id_token: token,
        refresh_token: "refresh",
        scope: "chatgpt.tokens.use.direct",
      }),
    });
    await expect(
      finishSubscriptionAuth(
        started.attempt,
        `http://127.0.0.1:1455/auth/callback?code=code&client_id=oaiapp_test&state=${encodeURIComponent(state)}`,
        { fetch, jwks: trusted.jwks, now }
      )
    ).rejects.toThrow("invalid identity");
  });

  it("starts Grok with discovered endpoints and a device code", async () => {
    const { calls, fetch } = routeFetch({
      "https://auth.x.ai/.well-known/openid-configuration": json(discovery),
      "https://auth.x.ai/oauth2/device/code": () =>
        json({
          device_code: "device-1",
          expires_in: 900,
          interval: 3,
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.x.ai/device",
        }),
    });
    const started = await startSubscriptionAuth("grok", "host-1", {
      fetch,
      now: 1000,
    });

    expect(started.attempt.deviceCode).toBe("device-1");
    expect(started.public.userCode).toBe("ABCD-EFGH");
    expect(started.public.url).toBe("https://auth.x.ai/device");
    expect(started.attempt.intervalMs).toBe(3000);
    expect(calls).toHaveLength(2);
    const params = new URLSearchParams(String(calls[1]?.init?.body));
    expect(params.get("scope")).toContain("grok-cli:access");
    expect(params.get("scope")).toContain("api:access");
  });

  it("polls Grok, handles slow_down, then validates account identity", async () => {
    const startRoutes = routeFetch({
      "https://auth.x.ai/.well-known/openid-configuration": json(discovery),
      "https://auth.x.ai/oauth2/device/code": json({
        device_code: "device-1",
        expires_in: 900,
        interval: 3,
        user_code: "CODE",
        verification_uri: "https://auth.x.ai/device",
      }),
    });
    const started = await startSubscriptionAuth("grok", "host-1", {
      fetch: startRoutes.fetch,
      now: 1000,
    });
    let polls = 0;
    const pollRoutes = routeFetch({
      "https://auth.x.ai/.well-known/openid-configuration": json(discovery),
      "https://auth.x.ai/oauth2/token": () => {
        polls += 1;
        return polls === 1
          ? json({ error: "slow_down" }, 400)
          : json({
              access_token: "grok-access",
              expires_in: 3600,
              refresh_token: "grok-refresh",
            });
      },
      "https://auth.x.ai/oauth2/userinfo": json({ sub: "xai-account" }),
    });

    await expect(
      finishSubscriptionAuth(started.attempt, undefined, {
        fetch: pollRoutes.fetch,
        now: 1000,
      })
    ).resolves.toBeNull();
    expect(started.attempt.intervalMs).toBe(8000);
    await expect(
      finishSubscriptionAuth(started.attempt, undefined, {
        fetch: pollRoutes.fetch,
        now: 1000,
      })
    ).resolves.toMatchObject({
      accessToken: "grok-access",
      accountId: "xai-account",
      refreshToken: "grok-refresh",
    });
  });

  it("rejects a Grok device response that points outside xAI's auth hosts", async () => {
    const { fetch } = routeFetch({
      "https://auth.x.ai/.well-known/openid-configuration": json(discovery),
      "https://auth.x.ai/oauth2/device/code": json({
        device_code: "device-1",
        expires_in: 900,
        interval: 3,
        user_code: "CODE",
        verification_uri: "https://evil.example/device",
      }),
    });
    await expect(
      startSubscriptionAuth("grok", "host-1", { fetch, now: 1000 })
    ).rejects.toThrow("verification URL");
  });

  it("refreshes Grok with a rotated refresh token and rejects account changes", async () => {
    const credentials: SubscriptionCredentials = {
      accessToken: "old-access",
      accountId: "xai-account",
      clientId: "client-1",
      expiresAt: 1000,
      refreshToken: "old-refresh",
    };
    const { calls, fetch } = routeFetch({
      "https://auth.x.ai/.well-known/openid-configuration": json(discovery),
      "https://auth.x.ai/oauth2/token": json({
        access_token: "new-access",
        expires_in: 3600,
        refresh_token: "new-refresh",
      }),
      "https://auth.x.ai/oauth2/userinfo": json({ sub: "xai-account" }),
    });
    const refreshed = await refreshSubscriptionCredentials(
      "grok",
      credentials,
      { fetch, now: 1000 }
    );
    expect(refreshed).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });
    expect(
      new URLSearchParams(String(calls[1]?.init?.body)).get("grant_type")
    ).toBe("refresh_token");
  });

  it("verifies a refreshed ChatGPT identity token instead of trusting decoded claims", async () => {
    const now = 1_700_000_000_000;
    const credentials: SubscriptionCredentials = {
      accessToken: "old-access",
      accountId: "openai-account",
      clientId: "oaiapp_test",
      expiresAt: 1000,
      refreshToken: "old-refresh",
    };
    const trusted = await signedIdToken({
      expiresAt: Math.floor(now / 1000) + 300,
    });
    const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const foreignToken = await signedIdToken({
      expiresAt: Math.floor(now / 1000) + 300,
      privateKey: foreign.privateKey,
    });
    const { fetch } = routeFetch({
      "https://auth.openai.com/api/accounts/oauth/token": json({
        access_token: "new-access",
        expires_in: 3600,
        id_token: trusted.token,
        refresh_token: "new-refresh",
      }),
    });
    await expect(
      refreshSubscriptionCredentials("chatgpt", credentials, {
        fetch,
        jwks: trusted.jwks,
        now,
      })
    ).resolves.toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
    });

    const invalidFetch = routeFetch({
      "https://auth.openai.com/api/accounts/oauth/token": json({
        access_token: "new-access",
        expires_in: 3600,
        id_token: foreignToken.token,
        refresh_token: "new-refresh",
      }),
    });
    await expect(
      refreshSubscriptionCredentials("chatgpt", credentials, {
        fetch: invalidFetch.fetch,
        jwks: trusted.jwks,
        now,
      })
    ).rejects.toThrow("invalid identity");
  });

  it("lists only account-advertised models and namespaces them by provider", async () => {
    const credentials: SubscriptionCredentials = {
      accessToken: "access",
      accountId: "account",
      clientId: "client",
      expiresAt: Date.now() + 10_000,
      refreshToken: "refresh",
    };
    const { calls: chatCalls, fetch: chatFetch } = routeFetch({
      "https://api.openai.com/v1/models": json({
        models: [
          { display_name: "GPT", slug: "gpt-6.1-sol", visibility: "list" },
          { display_name: "Hidden", slug: "hidden", visibility: "private" },
        ],
      }),
    });
    await expect(
      listSubscriptionModels("chatgpt", credentials, { fetch: chatFetch })
    ).resolves.toEqual([{ id: "chatgpt/gpt-6.1-sol", label: "GPT" }]);
    expect(chatCalls[0]?.init?.headers).toMatchObject({
      Authorization: "Bearer access",
    });

    const { calls: grokCalls, fetch: grokFetch } = routeFetch({
      "https://cli-chat-proxy.grok.com/v1/models": json({
        data: [
          { id: "grok-4.7", name: "Grok 4.7" },
          { id: "grok-4.7", name: "Duplicate" },
          { id: "bad model", name: "Invalid" },
        ],
      }),
    });
    await expect(
      listSubscriptionModels("grok", credentials, { fetch: grokFetch })
    ).resolves.toEqual([{ id: "grok/grok-4.7", label: "Grok 4.7" }]);
    expect(grokCalls[0]?.init?.headers).toMatchObject({
      "X-XAI-Token-Auth": "xai-grok-cli",
      "x-grok-client-identifier": "busy",
      "x-userid": "account",
    });
  });
});
