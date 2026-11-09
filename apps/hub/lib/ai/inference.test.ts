import { describe, expect, it } from "vitest";
import {
  chatgptCacheCanary,
  hasSubscriptionModel,
  nativeSubscriptionModel,
  prepareSubscriptionBody,
  subscriptionHeaders,
  subscriptionUrl,
} from "./inference";

const credentials = {
  accessToken: "secret-access",
  accountId: "account-1",
  clientId: "client-1",
  expiresAt: Date.now() + 60_000,
  refreshToken: "secret-refresh",
};

describe("subscription inference boundary", () => {
  it("namespaces model ids and rejects cross-provider models", () => {
    expect(nativeSubscriptionModel("grok", "grok/grok-4.7")).toBe("grok-4.7");
    expect(nativeSubscriptionModel("chatgpt", "grok/grok-4.7")).toBeNull();
    expect(
      hasSubscriptionModel(
        [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
        "grok",
        "grok/grok-4.7"
      )
    ).toBe(true);
    expect(
      hasSubscriptionModel(
        [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
        "chatgpt",
        "grok/grok-4.7"
      )
    ).toBe(false);
  });

  it("forces streaming and disables storage while dropping unknown request keys", () => {
    expect(
      prepareSubscriptionBody(
        "chatgpt",
        {
          input: [{ content: "hello", role: "user" }],
          model: "gpt-6.1-sol",
          store: true,
          stream: false,
          unknown: "drop",
        },
        "gpt-6.1-sol"
      )
    ).toEqual({
      input: [{ content: "hello", role: "user" }],
      model: "gpt-6.1-sol",
      store: false,
      stream: true,
    });
  });

  it.each(["chatgpt", "grok"] as const)(
    "preserves %s prompt cache affinity through the proxy allowlist",
    (provider) => {
      expect(
        prepareSubscriptionBody(
          provider,
          {
            input: "hello",
            model: "example",
            prompt_cache_key: "session-hash",
          },
          "example"
        )
      ).toMatchObject({
        prompt_cache_key: "session-hash",
        store: false,
        stream: true,
      });
    }
  );

  it("rejects previous response state for ChatGPT plan requests", () => {
    expect(() =>
      prepareSubscriptionBody(
        "chatgpt",
        { model: "gpt-6.1-sol", previous_response_id: "r1" },
        "gpt-6.1-sol"
      )
    ).toThrow("unsupported_state");
  });

  it("uses provider-specific endpoints and never leaks credentials through headers", () => {
    expect(subscriptionUrl("chatgpt")).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(subscriptionUrl("grok")).toBe(
      "https://cli-chat-proxy.grok.com/v1/responses"
    );
    const grok = subscriptionHeaders("grok", credentials);
    expect(grok.get("authorization")).toBe("Bearer secret-access");
    expect(grok.get("x-grok-user-id")).toBe("account-1");
    expect(grok.get("x-grok-client-identifier")).toBe("busy");
    expect(grok.get("x-grok-client-version")).toBe("1.0.13");
    expect(grok.get("xai-api-key")).toBeNull();
    expect(
      subscriptionHeaders("chatgpt", credentials).get("x-grok-client-version")
    ).toBeNull();
  });

  it("selects ChatGPT cache canary bots by slug or wildcard", () => {
    expect(chatgptCacheCanary("chatgpt", "ana", "bob, ana")).toBe(true);
    expect(chatgptCacheCanary("chatgpt", "ana", "*")).toBe(true);
    expect(chatgptCacheCanary("chatgpt", "ana", "bob")).toBe(false);
    expect(chatgptCacheCanary("chatgpt", "ana", undefined)).toBe(false);
    expect(chatgptCacheCanary("chatgpt", "ana", "")).toBe(false);
    expect(chatgptCacheCanary("grok", "ana", "*")).toBe(false);
  });

  it("keeps the current ChatGPT request outside the cache canary", () => {
    const body = {
      input: "hello",
      model: "gpt-6.1-sol",
      prompt_cache_key: "session-hash",
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    };
    expect(
      prepareSubscriptionBody("chatgpt", body, "gpt-6.1-sol")
    ).not.toHaveProperty("prompt_cache_options");
    const headers = subscriptionHeaders("chatgpt", credentials);
    expect([...headers.keys()].sort()).toEqual([
      "accept",
      "authorization",
      "content-type",
    ]);
  });

  it("forwards cache options and session affinity for canary bots", () => {
    expect(
      prepareSubscriptionBody(
        "chatgpt",
        {
          input: "hello",
          model: "gpt-6.1-sol",
          prompt_cache_options: { mode: "implicit", ttl: "30m" },
        },
        "gpt-6.1-sol",
        true
      )
    ).toMatchObject({
      prompt_cache_options: { mode: "implicit", ttl: "30m" },
    });
    const headers = subscriptionHeaders("chatgpt", credentials, {
      promptCacheKey: "session-hash",
    });
    expect(headers.get("session-id")).toBe("session-hash");
    expect(headers.get("chatgpt-account-id")).toBe("account-1");
    expect(headers.get("authorization")).toBe("Bearer secret-access");
    expect(
      subscriptionHeaders("chatgpt", { ...credentials, accountId: "" }, {}).get(
        "chatgpt-account-id"
      )
    ).toBeNull();
    const grok = subscriptionHeaders("grok", credentials, {
      promptCacheKey: "session-hash",
    });
    expect(grok.get("session-id")).toBeNull();
    expect(grok.get("chatgpt-account-id")).toBeNull();
  });
});

describe("chatgptCacheParts", () => {
  it("applies all parts by default and only the listed ones otherwise", async () => {
    const { chatgptCacheParts } = await import("./inference");
    expect([...chatgptCacheParts(undefined)].sort()).toEqual([
      "account",
      "options",
      "session",
    ]);
    expect([...chatgptCacheParts("session, nope")]).toEqual(["session"]);
    expect([...chatgptCacheParts("options,account")].sort()).toEqual([
      "account",
      "options",
    ]);
  });
});
