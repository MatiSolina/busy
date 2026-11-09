import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as CANCEL,
  POST as COMPLETE,
} from "./app/api/ai/connections/[provider]/complete/route";
import { DELETE, GET, POST } from "./app/api/ai/connections/[provider]/route";

const mocks = vi.hoisted(() => ({
  authenticatedUser: vi.fn(),
  cancelConnectionAttempt: vi.fn(),
  completeConnection: vi.fn(),
  disconnectConnection: vi.fn(),
  listSubscriptionConnections: vi.fn(),
  startConnection: vi.fn(),
}));

vi.mock("@/lib/ai/subscription-http", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/ai/subscription-http")
  >("@/lib/ai/subscription-http");
  return { ...actual, authenticatedUser: mocks.authenticatedUser };
});
vi.mock("@/lib/ai/subscription-store", () => ({
  cancelConnectionAttempt: mocks.cancelConnectionAttempt,
  completeConnection: mocks.completeConnection,
  disconnectConnection: mocks.disconnectConnection,
  listSubscriptionConnections: mocks.listSubscriptionConnections,
  startConnection: mocks.startConnection,
}));

const context = (provider: string) => ({
  params: Promise.resolve({ provider }),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticatedUser.mockResolvedValue("user-1");
  mocks.listSubscriptionConnections.mockResolvedValue([
    {
      accountLabel: "Account abc",
      models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
      provider: "grok",
    },
  ]);
  mocks.startConnection.mockResolvedValue({
    attemptId: "11111111-1111-4111-8111-111111111111",
    expiresAt: Date.now() + 60_000,
    intervalMs: 5000,
    kind: "device",
    provider: "grok",
    url: "https://auth.x.ai/device",
    userCode: "ABCD-EFGH",
  });
  mocks.completeConnection.mockResolvedValue({ status: "connected" });
  mocks.cancelConnectionAttempt.mockResolvedValue(undefined);
});

describe("subscription connection routes", () => {
  it("requires the Busy session and returns only public connection metadata", async () => {
    const response = await GET(
      new Request("https://busy.test"),
      context("grok")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connection: expect.objectContaining({ provider: "grok" }),
    });

    mocks.authenticatedUser.mockResolvedValue(null);
    expect(
      (await GET(new Request("https://busy.test"), context("grok"))).status
    ).toBe(401);
  });

  it("starts, completes and disconnects a provider without returning credentials", async () => {
    const started = await POST(
      new Request("https://busy.test", { method: "POST" }),
      context("grok")
    );
    expect(started.status).toBe(200);
    expect((await started.json()).url).toBe("https://auth.x.ai/device");
    expect(mocks.startConnection).toHaveBeenCalledWith("grok", "user-1");

    const complete = await COMPLETE(
      new Request("https://busy.test", {
        body: JSON.stringify({
          attemptId: "11111111-1111-4111-8111-111111111111",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context("grok")
    );
    expect(complete.status).toBe(200);
    expect(await complete.json()).toEqual({ status: "connected" });

    const cancelled = await CANCEL(
      new Request("https://busy.test", {
        body: JSON.stringify({
          attemptId: "11111111-1111-4111-8111-111111111111",
        }),
        headers: { "content-type": "application/json" },
        method: "DELETE",
      }),
      context("grok")
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ ok: true });
    expect(mocks.cancelConnectionAttempt).toHaveBeenCalledWith(
      "grok",
      "user-1",
      "11111111-1111-4111-8111-111111111111"
    );

    const disconnected = await DELETE(
      new Request("https://busy.test", { method: "DELETE" }),
      context("grok")
    );
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toEqual({ ok: true });
  });

  it("derives a loopback callback for local ChatGPT authorization", async () => {
    const started = await POST(
      new Request("http://localhost:3000/api/ai/connections/chatgpt", {
        method: "POST",
      }),
      context("chatgpt")
    );
    expect(started.status).toBe(200);
    expect(mocks.startConnection).toHaveBeenCalledWith("chatgpt", "user-1", {
      redirectUri: "http://127.0.0.1:3000/auth/callback",
    });
  });

  it("does not start a web ChatGPT flow without a local callback listener", async () => {
    const response = await POST(
      new Request("https://busy.test/api/ai/connections/chatgpt", {
        method: "POST",
      }),
      context("chatgpt")
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      action: "sign-in",
      code: "chatgpt_desktop_required",
      error: "chatgpt_desktop_required",
      message: "ChatGPT connections require the Busy desktop app.",
      provider: "chatgpt",
      retryable: false,
    });
    expect(mocks.startConnection).not.toHaveBeenCalled();
  });

  it("accepts an empty start body but rejects malformed and oversized bodies", async () => {
    const empty = await POST(
      new Request("https://busy.test/api/ai/connections/grok", {
        method: "POST",
      }),
      context("grok")
    );
    expect(empty.status).toBe(200);

    mocks.startConnection.mockClear();
    const malformed = await POST(
      new Request("https://busy.test/api/ai/connections/grok", {
        body: "not-json",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context("grok")
    );
    expect(malformed.status).toBe(400);

    const oversized = await POST(
      new Request("https://busy.test/api/ai/connections/grok", {
        body: JSON.stringify({ redirectUri: "x".repeat(9000) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context("grok")
    );
    expect(oversized.status).toBe(400);
    expect(mocks.startConnection).toHaveBeenCalledTimes(0);
  });

  it("rejects unknown providers and oversized or malformed completion bodies", async () => {
    expect(
      (
        await POST(
          new Request("https://busy.test", { method: "POST" }),
          context("google")
        )
      ).status
    ).toBe(404);
    const malformed = await COMPLETE(
      new Request("https://busy.test", {
        body: JSON.stringify({ callbackUrl: "https://bad.test" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      context("grok")
    );
    expect(malformed.status).toBe(400);
    expect(mocks.completeConnection).not.toHaveBeenCalled();
  });
});
