import { request } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatGptBroker } from "./subscription-auth.mjs";

const brokers: ReturnType<typeof createChatGptBroker>[] = [];

afterEach(() => {
  for (const broker of brokers.splice(0)) {
    broker.cancel();
  }
});

function callback(uri: string, query: string) {
  const parsed = new URL(uri);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      `${parsed.origin}${parsed.pathname}?${query}`,
      { method: "GET" },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function preparedBroker() {
  const openExternal = vi.fn(async () => {
    // Keep the test browser unopened while asserting the broker contract.
  });
  const fetchImpl = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: "connected" }), { status: 200 })
  );
  const broker = createChatGptBroker({
    fetchImpl,
    hub: "http://localhost:3000",
    openExternal,
  });
  brokers.push(broker);
  const { redirectUri } = await broker.prepare();
  const state = "state-123";
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  const attempt = {
    attemptId: "attempt-1",
    expiresAt: Date.now() + 60_000,
    kind: "browser" as const,
    provider: "chatgpt" as const,
    url: url.href,
  };
  return { attempt, broker, fetchImpl, openExternal, redirectUri, state };
}

describe("ChatGPT loopback broker", () => {
  it("starts the callback listener before opening authorization", async () => {
    const { broker, redirectUri } = await preparedBroker();
    expect(new URL(redirectUri).hostname).toBe("127.0.0.1");
    expect(new URL(redirectUri).pathname).toBe("/auth/callback");
    expect(broker.redirectUri).toBe(redirectUri);
  });

  it("deduplicates concurrent listener preparation", async () => {
    const broker = createChatGptBroker({ hub: "http://localhost:3000" });
    brokers.push(broker);
    const [first, second] = await Promise.all([
      broker.prepare(),
      broker.prepare(),
    ]);
    expect(second.redirectUri).toBe(first.redirectUri);
  });

  it("does not forward a callback before an authorization is opened", async () => {
    const { fetchImpl, redirectUri, state } = await preparedBroker();
    const result = await callback(redirectUri, `code=secret&state=${state}`);
    expect(result.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pins the state and forwards a valid callback through the hub session", async () => {
    const { attempt, broker, fetchImpl, openExternal, redirectUri, state } =
      await preparedBroker();
    await broker.open(attempt);
    expect(openExternal).toHaveBeenCalledWith(attempt.url);
    const result = await callback(redirectUri, `code=secret&state=${state}`);
    expect(result.status).toBe(200);
    expect(result.body).toContain("Connected");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:3000/api/ai/connections/chatgpt/complete",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1]?.body as string) as {
      attemptId: string;
      callbackUrl: string;
    };
    expect(body.attemptId).toBe(attempt.attemptId);
    expect(body.callbackUrl).toContain(`state=${state}`);
  });

  it("rejects a mismatched state without forwarding the code", async () => {
    const { attempt, broker, fetchImpl, redirectUri } = await preparedBroker();
    await broker.open(attempt);
    const result = await callback(redirectUri, "code=secret&state=wrong");
    expect(result.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not let a stale callback close a replacement listener", async () => {
    let resolveForward: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveForward = resolve;
        })
    );
    const broker = createChatGptBroker({
      fetchImpl,
      hub: "http://localhost:3000",
    });
    brokers.push(broker);
    const first = await broker.prepare();
    const firstState = "first-state";
    const firstUrl = new URL("https://auth.openai.com/api/accounts/authorize");
    firstUrl.searchParams.set("redirect_uri", first.redirectUri);
    firstUrl.searchParams.set("state", firstState);
    await broker.open({
      attemptId: "first-attempt",
      expiresAt: Date.now() + 60_000,
      kind: "browser",
      provider: "chatgpt",
      url: firstUrl.href,
    });
    const staleCallback = callback(
      first.redirectUri,
      `code=old&state=${firstState}`
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    broker.cancel();
    const second = await broker.prepare();
    const secondState = "second-state";
    const secondUrl = new URL("https://auth.openai.com/api/accounts/authorize");
    secondUrl.searchParams.set("redirect_uri", second.redirectUri);
    secondUrl.searchParams.set("state", secondState);
    await broker.open({
      attemptId: "second-attempt",
      expiresAt: Date.now() + 60_000,
      kind: "browser",
      provider: "chatgpt",
      url: secondUrl.href,
    });
    resolveForward?.(
      new Response(JSON.stringify({ status: "connected" }), { status: 200 })
    );
    await staleCallback;
    expect(broker.redirectUri).toBe(second.redirectUri);
    expect(broker.redirectUri).not.toBe(first.redirectUri);
  });

  it("does not treat an error response with a connected body as success", async () => {
    const openExternal = vi.fn(async () => {
      // Keep the test browser unopened while asserting the response contract.
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "connected" }), { status: 500 })
    );
    const broker = createChatGptBroker({
      fetchImpl,
      hub: "http://localhost:3000",
      openExternal,
    });
    brokers.push(broker);
    const { redirectUri } = await broker.prepare();
    const state = "error-response-state";
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    await broker.open({
      attemptId: "error-response-attempt",
      expiresAt: Date.now() + 60_000,
      kind: "browser",
      provider: "chatgpt",
      url: url.href,
    });
    const result = await callback(redirectUri, `code=secret&state=${state}`);
    expect(result.status).toBe(502);
    expect(result.body).toContain("Connection failed");
    expect(openExternal).toHaveBeenCalledOnce();
  });

  it("rejects authorization URLs that are not the OpenAI authorize endpoint", async () => {
    const { broker, redirectUri } = await preparedBroker();
    await expect(
      broker.open({
        attemptId: "attempt-1",
        expiresAt: Date.now() + 60_000,
        kind: "browser",
        provider: "chatgpt",
        url: `https://evil.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=state-123`,
      })
    ).rejects.toThrow("authorization is invalid");
  });
});
