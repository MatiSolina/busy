import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { subscriptionModel } from "./subscription-model";

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: async () => "test-oidc",
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("subscription prompt cache affinity", () => {
  it("sends a stable, provider-scoped session hash through the real SDK on every model call", async () => {
    vi.stubEnv("HUB_URL", "https://busy.test");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return Promise.resolve(
          new Response("data: [DONE]\n\n", {
            headers: { "content-type": "text/event-stream" },
          })
        );
      })
    );
    const sessionId = "private-session-id";
    const invoke = async (provider: "grok" | "chatgpt", session: string) => {
      const model = subscriptionModel(provider, `${provider}/example`, session);
      const result = await model.doStream({
        prompt: [{ content: [{ text: "hello", type: "text" }], role: "user" }],
        providerOptions: { openai: { store: false } },
      });
      await result.stream.pipeTo(new WritableStream());
    };
    await invoke("grok", sessionId);
    await invoke("grok", sessionId);
    await invoke("grok", "another-session");
    await invoke("chatgpt", sessionId);

    const expected = createHash("sha256")
      .update(`grok\u0000${sessionId}`)
      .digest("hex");
    expect(bodies.map((body) => body.prompt_cache_key)).toEqual([
      expected,
      expected,
      expect.any(String),
      expect.any(String),
    ]);
    expect(bodies[2]?.prompt_cache_key).not.toBe(expected);
    expect(bodies[3]?.prompt_cache_key).not.toBe(expected);
    expect(JSON.stringify(bodies)).not.toContain(sessionId);
    expect(
      bodies.every((body) => body.store === false && body.stream === true)
    ).toBe(true);
  });
});
