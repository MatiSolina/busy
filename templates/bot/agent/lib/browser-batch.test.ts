import { describe, expect, it } from "vitest";
import {
  BROWSER_BATCH_MAX_STEPS,
  BROWSER_BATCH_MODEL_OUTPUT_CHARS,
  boundBrowserBatchForModel,
  browserBatchInputSchema,
  dataUrlParts,
} from "./browser-batch";

describe("browser batch contract", () => {
  it("accepts known declarative actions and rejects eval/unknown fields", () => {
    expect(
      browserBatchInputSchema.safeParse({
        actions: [
          { action: "open", url: "https://example.com" },
          { action: "snapshot" },
          { action: "fill", selector: "@e1", text: "The user" },
          { action: "wait_ms", ms: 50 },
        ],
      }).success
    ).toBe(true);
    expect(
      browserBatchInputSchema.safeParse({
        actions: [{ action: "eval", code: "document.body" }],
      }).success
    ).toBe(false);
    expect(
      browserBatchInputSchema.safeParse({
        actions: [{ action: "click", arbitrary: true, selector: "@e1" }],
      }).success
    ).toBe(false);
  });

  it("rejects a batch larger than the hard step limit before execution", () => {
    const actions = Array.from({ length: BROWSER_BATCH_MAX_STEPS + 1 }, () => ({
      action: "wait_ms" as const,
      ms: 0,
    }));
    expect(browserBatchInputSchema.safeParse({ actions }).success).toBe(false);
  });

  it("rejects screenshot path traversal", () => {
    expect(
      browserBatchInputSchema.safeParse({
        actions: [
          { action: "screenshot", path: "/data/../workspace/leak.png" },
        ],
      }).success
    ).toBe(false);
  });

  it("bounds model output while preserving statuses and explicit recovery", () => {
    const result = boundBrowserBatchForModel(
      {
        attemptedCount: 2,
        executedCount: 1,
        finalSnapshot: { snapshot: "b".repeat(30_000) },
        finalSnapshotOk: false,
        partialSideEffects: true,
        requestedCount: 2,
        results: [
          {
            action: "fill",
            data: { value: "a".repeat(30_000) },
            executed: true,
            index: 0,
            success: true,
          },
          {
            action: "click",
            attempted: true,
            error: { code: "TAB_GONE", message: "x".repeat(30_000) },
            index: 1,
            success: false,
          },
        ],
        stoppedReason: "action_error",
        success: false,
      },
      BROWSER_BATCH_MODEL_OUTPUT_CHARS
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(
      BROWSER_BATCH_MODEL_OUTPUT_CHARS
    );
    expect(result.truncated).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.recovery).toContain("do not repeat");
  });

  it("keeps screenshot data out of bounded JSON but parses it for a file part", () => {
    const data = `data:image/png;base64,${"a".repeat(24)}`;
    const result = boundBrowserBatchForModel({
      executedCount: 1,
      finalSnapshot: {},
      finalSnapshotOk: true,
      partialSideEffects: true,
      requestedCount: 1,
      results: [
        {
          action: "screenshot",
          data: { imageDataUrl: data, path: "/data/s.png" },
          index: 0,
          success: true,
        },
      ],
      success: true,
    });
    expect(JSON.stringify(result)).not.toContain(data);
    expect(dataUrlParts(data)).toEqual({
      base64: "a".repeat(24),
      mediaType: "image/png",
    });
  });

  it("hard-caps pathological nested output at a small limit", () => {
    const result = boundBrowserBatchForModel(
      {
        attemptedCount: 12,
        error: { message: "e".repeat(30_000) },
        executedCount: 1,
        finalSnapshot: {
          values: Array.from({ length: 64 }, () => "z".repeat(2000)),
        },
        finalSnapshotError: { message: "q".repeat(30_000) },
        finalSnapshotOk: false,
        partialSideEffects: true,
        requestedCount: 12,
        results: Array.from({ length: 12 }, (_, index) => ({
          action: "click",
          data: { values: Array.from({ length: 64 }, () => "y".repeat(2000)) },
          error: { message: "x".repeat(30_000) },
          index,
          success: false,
        })),
        success: false,
      },
      1024
    );
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1024);
    expect(result.truncated).toBe(true);
  });
});
