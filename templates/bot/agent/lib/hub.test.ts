import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubFetch } from "./hub";

const h = vi.hoisted(() => ({
  fetch: vi.fn<typeof fetch>(),
  getVercelOidcToken: vi.fn(),
}));

vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: h.getVercelOidcToken,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HUB_URL", "https://hub.test");
  vi.stubGlobal("fetch", h.fetch);
  h.getVercelOidcToken.mockResolvedValue("bot-oidc-token");
  h.fetch.mockResolvedValue(Response.json({ ok: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hubFetch", () => {
  it.each<HeadersInit>([
    { "x-busy-session-id": "session-1" },
    [["x-busy-session-id", "session-1"]],
    new Headers({ "x-busy-session-id": "session-1" }),
  ])("preserves the file delivery session header from %j", async (headers) => {
    const body = JSON.stringify({
      contentType: "video/mp4",
      name: "video-de-prueba.mp4",
      size: 32_532,
    });

    await hubFetch("/api/bot/files", { body, headers, method: "POST" });

    expect(h.fetch).toHaveBeenCalledWith(
      "https://hub.test/api/bot/files",
      expect.objectContaining({ body, method: "POST" })
    );
    const sent = new Headers(h.fetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("x-busy-session-id")).toBe("session-1");
    expect(sent.get("authorization")).toBe("Bearer bot-oidc-token");
    expect(sent.get("content-type")).toBe("application/json");
  });

  it("keeps session metadata on completion requests without a body", async () => {
    await hubFetch("/api/bot/files/file-1/complete", {
      headers: { "x-busy-session-id": "session-1" },
      method: "POST",
    });

    const sent = new Headers(h.fetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("x-busy-session-id")).toBe("session-1");
    expect(sent.has("content-type")).toBe(false);
  });

  it("uses the bot's OIDC identity while preserving caller headers", async () => {
    const headers = new Headers({
      Authorization: "caller-supplied-token",
      "Content-Type": "application/custom+json",
    });

    await hubFetch("/api/bot/files", { body: "{}", headers, method: "POST" });

    const sent = new Headers(h.fetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer bot-oidc-token");
    expect(sent.get("content-type")).toBe("application/custom+json");
    expect(headers.get("authorization")).toBe("caller-supplied-token");
  });

  it("authenticates requests without caller headers", async () => {
    const response = await hubFetch("/api/bot/files");

    expect(response.ok).toBe(true);
    const sent = new Headers(h.fetch.mock.calls[0]?.[1]?.headers);
    expect(sent.get("authorization")).toBe("Bearer bot-oidc-token");
    expect(sent.has("content-type")).toBe(false);
  });
});
