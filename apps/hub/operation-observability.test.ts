import { describe, expect, it, vi } from "vitest";
import {
  observeOperation,
  operationErrorCode,
} from "./lib/operation-observability";

describe("operation observability", () => {
  it("emits only allowlisted metadata and excludes payload-shaped fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    observeOperation({
      durationMs: 12.7,
      entryPoint: "workflow",
      flow: "routine",
      model: "openai/gpt-6.1-sol",
      operationId: "run-1",
      outcome: "completed",
      provider: "gateway",
      requestId: "req-1",
      sessionId: "session-1",
      stage: "terminal",
      turnId: "turn-1",
    });
    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      durationMs: 13,
      flow: "routine",
      model: "openai/gpt-6.1-sol",
      outcome: "completed",
      source: "busy.operation",
      stage: "terminal",
    });
    expect(record).not.toHaveProperty("prompt");
    expect(record).not.toHaveProperty("input");
    expect(record).not.toHaveProperty("output");
    info.mockRestore();
  });

  it("drops invalid IDs, durations and unknown lifecycle values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    observeOperation({
      durationMs: -1,
      entryPoint: "cron",
      flow: "routine",
      operationId: "prompt=secret",
      outcome: "completed",
      provider: "gateway\nsecret",
      stage: "terminal",
    });
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("normalizes errors to a fixed safe code", () => {
    expect(operationErrorCode(new Error("password=secret"))).toBe("Error");
    expect(
      operationErrorCode(Object.assign(new Error("db"), { code: "23503" }))
    ).toBe("23503");
    expect(operationErrorCode(new TypeError("provider details"))).toBe(
      "TypeError"
    );
    expect(operationErrorCode({ message: "secret" })).toBe("unknown");
  });

  it("drops unknown canary keys and preserves valid W3C IDs", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    observeOperation({
      entryPoint: "workflow",
      flow: "fireside",
      operationId: "fireside-1",
      outcome: "completed",
      // @ts-expect-error The runtime guard must reject fields outside the interface too.
      password: "dummy",
      spanId: "0123456789abcdef",
      stage: "terminal",
      traceId: "0123456789abcdef0123456789abcdef",
    });
    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    });
    expect(record).not.toHaveProperty("password");
    info.mockRestore();
  });

  it("correlates consultation parent and child sessions without payload data", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    observeOperation({
      botId: "11111111-1111-4111-8111-111111111111",
      callId: "peer-1",
      childSessionId: "child-session",
      entryPoint: "http",
      flow: "consultation",
      operationId: "peer-1",
      outcome: "completed",
      parentSessionId: "parent-session",
      prompt: "private prompt",
      sessionId: "child-session",
      stage: "terminal",
    } as never);
    const record = JSON.parse(String(info.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(record).toMatchObject({
      callId: "peer-1",
      childSessionId: "child-session",
      flow: "consultation",
      operationId: "peer-1",
      outcome: "completed",
      parentSessionId: "parent-session",
      sessionId: "child-session",
      stage: "terminal",
    });
    expect(record).not.toHaveProperty("prompt");
    info.mockRestore();
  });

  it("rejects null, undefined and numeric operation IDs at runtime", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    for (const operationId of [null, undefined, 123]) {
      observeOperation({
        entryPoint: "workflow",
        flow: "routine",
        operationId: operationId as unknown as string,
        outcome: "completed",
        stage: "terminal",
      });
    }
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("does not let a failing log sink shadow the measured operation", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("log sink unavailable");
    });
    expect(() =>
      observeOperation({
        entryPoint: "workflow",
        flow: "code_task",
        operationId: "task-1",
        outcome: "completed",
        stage: "terminal",
      })
    ).not.toThrow();
    info.mockRestore();
  });
});
