import { describe, expect, it } from "vitest";
import { mergeCodeTaskUsage, publicCodeTaskUsage } from "./types";

describe("code task usage", () => {
  it("accumulates provider counters without treating missing dimensions as zero", () => {
    const first = mergeCodeTaskUsage(undefined, {
      cacheReadTokens: 10,
      inputTokens: 100,
      outputTokens: 25,
    });
    const second = mergeCodeTaskUsage(first, {
      inputTokens: 50,
      outputTokens: 5,
      reasoningTokens: 3,
    });

    expect(second).toEqual({
      cacheReadTokens: 10,
      cacheWriteTokens: null,
      inputTokens: 150,
      outputTokens: 30,
      reasoningTokens: 3,
      requests: 2,
    });
  });

  it("rejects malformed counters and makes subscription cost semantics explicit", () => {
    const totals = mergeCodeTaskUsage(undefined, {
      inputTokens: -1,
      outputTokens: "unknown",
    });
    expect(totals).toEqual({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      requests: 0,
    });
    expect(publicCodeTaskUsage(totals, "chatgpt")).toMatchObject({
      costStatus: "included",
      costUsd: null,
    });
    expect(publicCodeTaskUsage(totals, "gateway")).toMatchObject({
      costStatus: "unavailable",
      costUsd: null,
    });
  });
});
