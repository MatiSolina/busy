import { describe, expect, it, vi } from "vitest";
import {
  type BotCall,
  endSession,
  prewarmSession,
  readStreamAt,
  sendMessage,
} from "./client";

function fixtureBot(body: unknown[]): BotCall {
  return {
    fetchImpl: vi.fn((_input, init) => {
      body.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({ deliveryId: "delivery-1" }));
    }) as unknown as typeof fetch,
    token: () => Promise.resolve("test-token"),
    url: "https://bot.example.com",
  };
}

describe("eve session client", () => {
  it("sends a queued routine message through the HTTP session API", async () => {
    const bodies: unknown[] = [];
    const result = await sendMessage(fixtureBot(bodies), "session-1", {
      files: [],
      id: "11111111-1111-4111-8111-111111111111",
      text: "[ROUTINE] Run the daily report.",
      turnPolicy: "queue",
    });

    expect(result).toEqual({ deliveryId: "delivery-1" });
    expect(bodies).toEqual([
      {
        idempotencyKey: "11111111-1111-4111-8111-111111111111",
        message: "[ROUTINE] Run the daily report.",
        turnPolicy: "queue",
      },
    ]);
  });

  it("does not add a turn policy to ordinary messages", async () => {
    const bodies: unknown[] = [];
    await sendMessage(fixtureBot(bodies), "session-1", {
      files: [],
      id: "22222222-2222-4222-8222-222222222222",
      text: "Hello",
    });
    expect(bodies[0]).toEqual({
      idempotencyKey: "22222222-2222-4222-8222-222222222222",
      message: "Hello",
    });
  });

  it("sends ephemeral client context without persisting it in the message text", async () => {
    const bodies: unknown[] = [];
    await sendMessage(fixtureBot(bodies), "session-1", {
      clientContext: { timeZone: "America/Argentina/Cordoba" },
      files: [],
      id: "33333333-3333-4333-8333-333333333333",
      text: "Todos los días a las 9 hacé el resumen.",
    });
    expect(bodies[0]).toEqual({
      clientContext: { timeZone: "America/Argentina/Cordoba" },
      idempotencyKey: "33333333-3333-4333-8333-333333333333",
      message: "Todos los días a las 9 hacé el resumen.",
    });
  });
});

describe("fireside session retirement", () => {
  it("distinguishes an accepted end from a confirmed inactive session", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ deliveryId: "end" }))
      .mockResolvedValueOnce(
        Response.json({ code: "session_not_active" }, { status: 409 })
      );
    const call = { ...fixtureBot([]), fetchImpl };
    expect(await endSession(call, "isolated")).toBe(false);
    expect(await endSession(call, "isolated")).toBe(true);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://bot.example.com/eve/v1/session/isolated/end"
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe("POST");
  });
  it("does not mistake another transport conflict for a stopped session", async () => {
    const call = {
      ...fixtureBot([]),
      fetchImpl: vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json({ code: "session_not_ready" }, { status: 409 })
        ),
    };
    await expect(endSession(call, "isolated")).rejects.toThrow("end failed");
  });
});

describe("eve stream cancellation", () => {
  it("cancels a pending reader when the request signal aborts", async () => {
    const controller = new AbortController();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { "x-eve-stream-tail-index": "999" },
      })
    );
    const bot: BotCall = {
      fetchImpl,
      token: () => Promise.resolve("test-token"),
      url: "https://bot.example.com",
    };
    const next = readStreamAt(
      bot,
      "/session/stream",
      0,
      true,
      controller.signal
    ).next();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort();
    await expect(next).resolves.toMatchObject({ done: true });
    expect(canceled).toBe(true);
  });

  it("does not wait for an endless cancel after aborting between reads", async () => {
    const controller = new AbortController();
    let cancelCalled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise<never>(() => undefined);
      },
      start(stream) {
        stream.enqueue(new TextEncoder().encode('{"value":"one"}\n'));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: { "x-eve-stream-tail-index": "999" },
      })
    );
    const bot: BotCall = {
      fetchImpl,
      token: () => Promise.resolve("test-token"),
      url: "https://bot.example.com",
    };
    const records = readStreamAt(
      bot,
      "/session/stream",
      0,
      true,
      controller.signal
    );
    await expect(records.next()).resolves.toMatchObject({
      done: false,
      value: { line: 0, record: { value: "one" } },
    });

    controller.abort();
    const next = records.next();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timed out">((resolve) => {
      timeoutId = setTimeout(() => resolve("timed out"), 100);
    });
    const result = await Promise.race([next, timeout]);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    expect(result).not.toBe("timed out");
    expect(result).toMatchObject({ done: true });
    expect(cancelCalled).toBe(true);
  });

  it("prewarms with an empty POST so eve never reads it as a message", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ ok: true, status: "ready" }))
    );
    const status = await prewarmSession(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        token: () => Promise.resolve("test-token"),
        url: "https://bot.example.com",
      },
      "session-1"
    );
    expect(status).toBe("ready");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://bot.example.com/eve/v1/session/session-1");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
    expect(init.headers).not.toHaveProperty("Content-Type");
  });
});
