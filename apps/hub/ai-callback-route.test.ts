import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./app/auth/callback/route";

const mocks = vi.hoisted(() => ({
  completeLoopbackCallback: vi.fn(),
}));

vi.mock("@/lib/ai/subscription-store", () => ({
  completeLoopbackCallback: mocks.completeLoopbackCallback,
}));
vi.mock("@/lib/ai/subscription-types", () => ({
  SubscriptionConnectionError: class SubscriptionConnectionError extends Error {},
}));

const id = "11111111-1111-4111-8111-111111111111";
const state = `${id}.oauth-state`;

beforeEach(() => {
  mocks.completeLoopbackCallback.mockReset();
});

describe("ChatGPT loopback callback", () => {
  it("rejects callbacks outside the local loopback origin", async () => {
    const response = await GET(
      new Request(`https://busy.example/auth/callback?state=${state}`)
    );
    expect(response.status).toBe(400);
    expect(mocks.completeLoopbackCallback).not.toHaveBeenCalled();
  });

  it("rejects callbacks without a verifiable attempt state", async () => {
    const response = await GET(
      new Request("http://127.0.0.1:3000/auth/callback?state=forged")
    );
    expect(response.status).toBe(400);
    expect(mocks.completeLoopbackCallback).not.toHaveBeenCalled();
  });

  it("completes the loopback callback and never renders its query values", async () => {
    mocks.completeLoopbackCallback.mockResolvedValue({ status: "connected" });
    const callback = `http://127.0.0.1:3000/auth/callback?code=secret-code&state=${state}`;
    const response = await GET(
      new Request(callback, { headers: { host: "127.0.0.1:3000" } })
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(mocks.completeLoopbackCallback).toHaveBeenCalledWith(id, callback);
    expect(body).not.toContain("secret-code");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'"
    );
  });

  it("uses the direct Host header when Next normalizes request.url to localhost", async () => {
    mocks.completeLoopbackCallback.mockResolvedValue({ status: "connected" });
    const callback = `http://127.0.0.1:3000/auth/callback?code=secret-code&state=${state}`;
    const request = new Request(
      `http://localhost:3000/auth/callback?code=secret-code&state=${state}`,
      { headers: { host: "127.0.0.1:3000" } }
    );
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.completeLoopbackCallback).toHaveBeenCalledWith(id, callback);
  });

  it("rejects a normalized request with an external Host header", async () => {
    const response = await GET(
      new Request(`http://localhost:3000/auth/callback?state=${state}`, {
        headers: { host: "evil.example" },
      })
    );
    expect(response.status).toBe(400);
    expect(mocks.completeLoopbackCallback).not.toHaveBeenCalled();
  });
});
