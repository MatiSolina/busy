import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bot/firesides/gateway/language-model/route";
import { initialState } from "./lib/firesides/test-helpers";

const mocks = vi.hoisted(() => ({
  caller: vi.fn(),
  count: vi.fn(),
  fetch: vi.fn(),
  grant: vi.fn(),
}));
vi.mock("./lib/bot-auth", () => ({ botFromRequest: mocks.caller }));
vi.mock("./lib/firesides/auth", () => ({
  countModelRequest: mocks.count,
  runtimeParticipant: mocks.grant,
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  vi.stubEnv("AI_GATEWAY_API_KEY", "fixture-gateway");
  vi.stubEnv("TOKEN_PASS_API_KEY", "fixture-pass");
  mocks.caller.mockResolvedValue({ slug: "primary" });
  mocks.count.mockResolvedValue(true);
  mocks.fetch.mockResolvedValue(
    new Response("stream", { headers: { "content-type": "text/event-stream" } })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function request(model: string) {
  return new Request("https://hub/api", {
    body: JSON.stringify({ prompt: [] }),
    headers: {
      "ai-gateway-protocol-version": "0.0.1",
      "ai-language-model-id": model,
      "ai-language-model-specification-version": "4",
      "ai-language-model-streaming": "true",
    },
    method: "POST",
  });
}
function grant(billing: "gateway" | "token-pass") {
  const participant = {
    ...initialState().participants.primary,
    billing,
    model: "moonshotai/kimi-k3",
  };
  mocks.grant.mockResolvedValue({
    participant,
    revision: 7,
    row: { id: "fire" },
    sessionId: "isolated",
  });
  return participant.model;
}
describe("fireside Gateway billing boundary", () => {
  it.each(["gateway", "token-pass"] as const)(
    "keeps %s routing and the immutable model on the server",
    async (billing) => {
      expect((await POST(request(grant(billing)))).status).toBe(200);
      const [url, options] = mocks.fetch.mock.calls[0] ?? [];
      expect(url).toBe("https://ai-gateway.vercel.sh/v4/ai/language-model");
      expect(new Headers(options?.headers).get("authorization")).toBe(
        `Bearer ${billing === "token-pass" ? "fixture-pass" : "fixture-gateway"}`
      );
      expect(new Headers(options?.headers).get("ai-language-model-id")).toBe(
        "moonshotai/kimi-k3"
      );
      expect(
        new Headers(options?.headers).get("ai-gateway-protocol-version")
      ).toBe("0.0.1");
      expect(mocks.count.mock.calls[0]?.slice(2)).toEqual(["isolated", 7]);
    }
  );
  it("never falls back to Gateway when Token Pass is unavailable", async () => {
    vi.stubEnv("TOKEN_PASS_API_KEY", "");
    expect((await POST(request(grant("token-pass")))).status).toBe(409);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("rejects model switching and revoked turn grants before forwarding", async () => {
    grant("gateway");
    expect((await POST(request("other/model"))).status).toBe(403);
    mocks.count.mockResolvedValue(false);
    expect((await POST(request("moonshotai/kimi-k3"))).status).toBe(429);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
