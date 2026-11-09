import { describe, expect, it, vi } from "vitest";
import { MAX_QUEUED_BYTES, MAX_QUEUED_ROWS, relay, sseResponse } from "./sse";

describe("chat SSE relay", () => {
  it("sanitizes provider facts before sending and saving", async () => {
    const send = vi.fn();
    const save = vi.fn(() => Promise.resolve());
    async function* records() {
      yield await Promise.resolve({
        line: 4,
        record: {
          facts: [
            {
              data: {
                error: { message: "secret access token", status: 401 },
                outcome: "failed",
              },
              type: "model.settled",
            },
          ],
        },
      });
    }
    await expect(
      relay(records(), save, send, () => false, "chatgpt")
    ).resolves.toBe(true);
    expect(JSON.stringify(send.mock.calls)).not.toContain(
      "secret access token"
    );
    expect(save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            data: {
              error: { code: "connection_not_connected", provider: "chatgpt" },
              outcome: "failed",
            },
          }),
        }),
      ]),
      5
    );
  });

  it("emits one metadata-only stream summary without token-level logs", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const save = vi.fn(() => Promise.resolve());
    async function* records() {
      await Promise.resolve();
      yield {
        line: 1,
        record: {
          facts: [
            {
              data: { value: "private reply" },
              type: "content.completed",
            },
          ],
        },
      };
      yield { line: 2, record: { progress: { token: "ignored" } } };
    }

    await expect(
      relay(records(), save, vi.fn(), () => false, undefined, {
        botSlug: "contracts",
        requestId: "iad1::trace",
        sessionId: "session-1",
      })
    ).resolves.toBe(true);

    expect(info).toHaveBeenCalledOnce();
    const payload = JSON.parse(info.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      event: "chat.stream",
      factsForwarded: 1,
      outcome: "completed",
      recordsSeen: 2,
      sessionId: "session-1",
    });
    expect(JSON.stringify(payload)).not.toContain("private reply");
    info.mockRestore();
  });

  it("records a bounded persistence failure without logging the exception", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    async function* records() {
      await Promise.resolve();
      yield {
        line: 1,
        record: {
          facts: [{ data: { value: "reply" }, type: "content.completed" }],
        },
      };
    }
    const save = vi.fn(() => Promise.reject(new Error("password=secret")));

    await expect(
      relay(records(), save, vi.fn(), () => false, undefined, {
        botSlug: "contracts",
        sessionId: "session-1",
      })
    ).resolves.toBe(false);

    expect(info).toHaveBeenCalledOnce();
    const payload = JSON.parse(info.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({
      errorCode: "Error",
      event: "chat.stream",
      outcome: "persistence_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("password=secret");
    info.mockRestore();
  });

  it("batches durable records while forwarding every fact immediately", async () => {
    const save = vi.fn(() => Promise.resolve());
    const send = vi.fn();
    async function* records() {
      await Promise.resolve();
      for (const line of [1, 2, 3, 4]) {
        yield {
          line,
          record: {
            facts: [
              {
                data: { value: `reply-${line}` },
                type: "content.completed",
              },
            ],
          },
        };
      }
    }

    await expect(relay(records(), save, send, () => false)).resolves.toBe(true);

    expect(send).toHaveBeenCalledTimes(4);
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ line: 1 }),
        expect.objectContaining({ line: 4 }),
      ]),
      5
    );
  });

  it("aborts a live run when the SSE consumer disconnects", async () => {
    let started!: () => void;
    let aborted!: () => void;
    let runFinished!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abortedPromise = new Promise<void>((resolve) => {
      aborted = resolve;
    });
    const runFinishedPromise = new Promise<void>((resolve) => {
      runFinished = resolve;
    });
    const response = sseResponse(
      new Request("https://busy.test/events"),
      async (_send, _closed, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted();
              resolve();
            },
            { once: true }
          )
        );
        runFinished();
      }
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await startedPromise;
    await reader?.cancel();
    await abortedPromise;
    await runFinishedPromise;
  });

  it("propagates a request that was already aborted before SSE setup", async () => {
    const requestController = new AbortController();
    requestController.abort();
    let observedClosed = false;
    let observedAborted = false;
    const response = sseResponse(
      new Request("https://busy.test/events", {
        signal: requestController.signal,
      }),
      (_send, closed, signal) => {
        observedClosed = closed();
        observedAborted = signal.aborted;
        return Promise.resolve();
      }
    );

    const reader = response.body?.getReader();
    await expect(reader?.read()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(observedClosed).toBe(true);
    expect(observedAborted).toBe(true);
  });

  it("flushes durable rows when the actual SSE reader cancels during idle follow", async () => {
    const save = vi.fn(() => Promise.resolve());
    let idleStarted!: () => void;
    let runFinished!: () => void;
    const idleStartedPromise = new Promise<void>((resolve) => {
      idleStarted = resolve;
    });
    const runFinishedPromise = new Promise<void>((resolve) => {
      runFinished = resolve;
    });
    async function* records(signal: AbortSignal) {
      yield {
        line: 1,
        record: {
          facts: [{ data: { value: "durable" }, type: "content.completed" }],
        },
      };
      idleStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      );
    }

    const response = sseResponse(
      new Request("https://busy.test/events"),
      async (send, closed, signal) => {
        await relay(records(signal), save, send, closed);
        runFinished();
      }
    );
    const reader = response.body?.getReader();
    await reader?.read();
    await idleStartedPromise;
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());

    await reader?.cancel();
    await runFinishedPromise;
    expect(save).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          line: 1,
          type: "content.completed",
        }),
      ],
      2
    );
  });

  it("applies bounded backpressure when persistence is slower than the stream", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const send = vi.fn();
    let rowsSaved = 0;
    let finalCursor = 0;
    const save = vi.fn(async (rows, nextLine: number) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      rowsSaved += rows.length;
      finalCursor = Math.max(finalCursor, nextLine);
    });
    async function* records() {
      await Promise.resolve();
      for (let line = 1; line <= 6000; line += 1) {
        yield {
          line,
          record: {
            facts: [
              {
                data: { value: `reply-${line}` },
                type: "content.completed",
              },
              {
                data: { value: `status-${line}` },
                type: "call.settled",
              },
            ],
          },
        };
      }
    }

    await expect(
      relay(records(), save, send, () => false, undefined, {
        botSlug: "contracts",
        sessionId: "session-pressure",
      })
    ).resolves.toBe(true);

    const payload = JSON.parse(info.mock.calls[0]?.[0] as string);
    expect(payload.pressureWaits).toBeGreaterThan(0);
    expect(payload.maxQueuedRows).toBeLessThanOrEqual(MAX_QUEUED_ROWS + 4);
    expect(rowsSaved).toBe(12_000);
    expect(finalCursor).toBe(6001);
    expect(send).toHaveBeenCalledTimes(12_000);
    expect(save).toHaveBeenCalled();
    info.mockRestore();
  });

  it("isolates an oversized atomic record from pending rows", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const batches: number[] = [];
    const save = vi.fn((rows) => {
      batches.push(rows.length);
      return Promise.resolve();
    });
    const largeValue = "x".repeat(2_200_000);
    async function* records() {
      await Promise.resolve();
      yield {
        line: 1,
        record: {
          facts: [{ data: { value: "small" }, type: "content.completed" }],
        },
      };
      yield {
        line: 2,
        record: {
          facts: [{ data: { value: largeValue }, type: "content.completed" }],
        },
      };
      yield {
        line: 3,
        record: {
          facts: [{ data: { value: "after" }, type: "content.completed" }],
        },
      };
    }

    await expect(
      relay(records(), save, vi.fn(), () => false, undefined, {
        botSlug: "contracts",
        sessionId: "session-oversized",
      })
    ).resolves.toBe(true);

    const payload = JSON.parse(info.mock.calls[0]?.[0] as string);
    expect(payload.oversizedRecordCount).toBe(1);
    expect(payload.oversizedRecordBytes).toBeGreaterThan(MAX_QUEUED_BYTES);
    expect(batches).toEqual([1, 1, 1]);
    info.mockRestore();
  });

  it("flushes a durable row when the consumer disconnects during the next read", async () => {
    let releaseNext!: () => void;
    let resolveSave!: () => void;
    let closed = false;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    async function* records() {
      yield {
        line: 1,
        record: {
          facts: [{ data: { value: "durable" }, type: "content.completed" }],
        },
      };
      await new Promise<void>((resolve) => {
        releaseNext = resolve;
      });
      yield {
        line: 2,
        record: {
          facts: [{ data: { value: "discarded" }, type: "content.completed" }],
        },
      };
    }
    const relayPromise = relay(records(), save, vi.fn(), () => closed);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    closed = true;
    releaseNext();
    resolveSave();
    await expect(relayPromise).resolves.toBe(false);
    expect(save).toHaveBeenCalledOnce();
  });
});
