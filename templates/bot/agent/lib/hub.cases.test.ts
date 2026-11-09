import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import { hubFetch } from "./hub";

const getVercelOidcToken = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("@vercel/oidc", () => ({ getVercelOidcToken }));

const fetchMock =
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const lastCall = () => {
  const [url, init] = defined(fetchMock.mock.calls.at(-1));
  return { headers: new Headers(init.headers), init, url };
};

beforeEach(() => {
  vi.stubEnv("HUB_URL", "https://hub.example.com");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockImplementation(async () => new Response("ok"));
  getVercelOidcToken.mockReset().mockResolvedValue("oidc-token");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hubFetch", () => {
  it.each([
    "/api/bot/memory",
    "/api/bot/files/1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed/complete",
    "/api/bot/directory?fresh=1",
  ])("calls HUB_URL + %s", async (path) => {
    await hubFetch(path);
    expect(lastCall().url).toBe(`https://hub.example.com${path}`);
  });

  it("reads HUB_URL on every call, not at import", async () => {
    await hubFetch("/a");
    vi.stubEnv("HUB_URL", "https://other-hub.example.com");
    await hubFetch("/a");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://hub.example.com/a",
      "https://other-hub.example.com/a",
    ]);
  });

  it("sends the Vercel OIDC token as a bearer", async () => {
    await hubFetch("/api/bot/memory");
    expect(lastCall().headers.get("Authorization")).toBe("Bearer oidc-token");
  });

  it("asks for a fresh token on every call", async () => {
    getVercelOidcToken.mockResolvedValueOnce("t1").mockResolvedValueOnce("t2");
    await hubFetch("/a");
    await hubFetch("/b");
    expect(
      fetchMock.mock.calls.map(([, init]) =>
        new Headers(init.headers).get("Authorization")
      )
    ).toEqual(["Bearer t1", "Bearer t2"]);
  });

  it("never lets the caller replace the bearer", async () => {
    await hubFetch("/a", { headers: { Authorization: "Bearer other" } });
    expect(lastCall().headers.get("Authorization")).toBe("Bearer oidc-token");
  });

  it.each<[string, RequestInit | undefined, string | undefined]>([
    ["no init", undefined, undefined],
    [
      "a GET with a signal",
      { signal: new AbortController().signal },
      undefined,
    ],
    ["a POST without body", { method: "POST" }, undefined],
    ["an empty-string body", { body: "", method: "PUT" }, undefined],
    [
      "a JSON body",
      { body: JSON.stringify({ a: 1 }), method: "PUT" },
      "application/json",
    ],
    [
      "a POST with a JSON body",
      { body: "{}", method: "POST" },
      "application/json",
    ],
  ])("with %s sends Content-Type %s", async (_, init, contentType) => {
    await hubFetch("/a", init);
    expect(lastCall().headers.get("Content-Type") ?? undefined).toBe(
      contentType
    );
  });

  it("passes method, body and signal through", async () => {
    const { signal } = new AbortController();
    await hubFetch("/a", { body: '{"x":1}', method: "PUT", signal });
    expect(lastCall().init).toMatchObject({
      body: '{"x":1}',
      method: "PUT",
      signal,
    });
  });

  it("returns the hub's response untouched, errors included", async () => {
    const res = new Response("nope", { status: 503 });
    fetchMock.mockResolvedValueOnce(res);
    expect(await hubFetch("/a")).toBe(res);
  });

  it("fails without calling the hub when there is no token", async () => {
    getVercelOidcToken.mockRejectedValueOnce(new Error("no OIDC token"));
    await expect(hubFetch("/a")).rejects.toThrow("no OIDC token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates a network error", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(hubFetch("/a")).rejects.toThrow("fetch failed");
  });
});
