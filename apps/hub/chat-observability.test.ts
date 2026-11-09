import { describe, expect, it, vi } from "vitest";
import {
  buildChatTraceTimeline,
  errorCodeOf,
  logChatObservation,
} from "./lib/chat/observability";

const message = {
  botSlug: "contracts",
  createdAt: "2026-11-04T18:00:00.000Z",
  deliveryId: "delivery-a",
  id: "11111111-1111-4111-8111-111111111111",
  status: "accepted",
};

const event = (
  line: number,
  type: string,
  data: Partial<{
    callId: string;
    attempt: number;
    deliveryId: string;
    interactionId: string;
    modelId: string;
    outcome: string;
    provider: string;
    runId: string;
    traceId: string;
    spanId: string;
    turnId: string;
    usageCacheReadText: string;
    usageCacheWriteText: string;
    usageCostText: string;
    usageKind: string;
    usageOwnerCallId: string;
    usageOwnerRunId: string;
    usageInputText: string;
    usageOutputText: string;
  }> = {},
  scope: { runId?: string; turnId?: string } = {}
) => ({
  at: new Date(2026, 10, 4, 18, 0, line),
  attempt: data.attempt ?? null,
  callId: data.callId ?? null,
  deliveryId: data.deliveryId ?? null,
  errorCode: null,
  index: 0,
  interactionId: data.interactionId ?? null,
  line,
  modelId: data.modelId ?? null,
  outcome: data.outcome ?? null,
  provider: data.provider ?? null,
  runId: scope.runId ?? data.runId ?? null,
  spanId: data.spanId ?? null,
  traceId: data.traceId ?? null,
  turnId: scope.turnId ?? data.turnId ?? null,
  type,
  usageCacheReadText: data.usageCacheReadText ?? null,
  usageCacheWriteText: data.usageCacheWriteText ?? null,
  usageCostText: data.usageCostText ?? null,
  usageInputText: data.usageInputText ?? null,
  usageKind: data.usageKind ?? null,
  usageOutputText: data.usageOutputText ?? null,
  usageOwnerCallId: data.usageOwnerCallId ?? null,
  usageOwnerRunId: data.usageOwnerRunId ?? null,
});

describe("chat observability", () => {
  it("folds only the requested delivery and turn", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(
        1,
        "turn.started",
        {
          spanId: "aaaaaaaaaaaaaaaa",
          traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          turnId: "turn-a",
        },
        { turnId: "turn-a" }
      ),
      event(
        1,
        "delivery.consumed",
        { deliveryId: "delivery-a", turnId: "turn-a" },
        { turnId: "turn-a" }
      ),
      event(
        2,
        "model.started",
        { runId: "run-a", turnId: "turn-a" },
        { runId: "run-a", turnId: "turn-a" }
      ),
      event(
        3,
        "call.requested",
        { callId: "call-a", turnId: "turn-a" },
        { runId: "run-a", turnId: "turn-a" }
      ),
      event(
        4,
        "call.settled",
        { callId: "call-a", outcome: "completed", turnId: "turn-a" },
        { runId: "run-a", turnId: "turn-a" }
      ),
      event(
        5,
        "model.settled",
        { outcome: "completed", runId: "run-a", turnId: "turn-a" },
        { runId: "run-a", turnId: "turn-a" }
      ),
      event(
        6,
        "turn.settled",
        { outcome: "completed", turnId: "turn-a" },
        { turnId: "turn-a" }
      ),
      event(
        6,
        "delivery.settled",
        { deliveryId: "delivery-a", outcome: "handled", turnId: "turn-a" },
        { turnId: "turn-a" }
      ),
      event(7, "delivery.admitted", { deliveryId: "delivery-b" }),
      event(
        8,
        "turn.started",
        { traceId: "trace-b", turnId: "turn-b" },
        { turnId: "turn-b" }
      ),
      event(
        9,
        "call.requested",
        { callId: "call-b", turnId: "turn-b" },
        { runId: "run-b", turnId: "turn-b" }
      ),
    ];

    const result = buildChatTraceTimeline(message, "session-1", rows);

    expect(result.complete).toBe(true);
    expect(result.correlation).toMatchObject({
      callIds: ["call-a"],
      deliveryId: "delivery-a",
      sessionId: "session-1",
      spanId: "aaaaaaaaaaaaaaaa",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      turnId: "turn-a",
    });
    expect(result.correlation.callIds).not.toContain("call-b");
    expect(result.stages.modelAttempts).toHaveLength(1);
    expect(result.stages.tools).toHaveLength(1);
    expect(result.stages.turn.durationMs).toBe(5000);
  });

  it("marks a retry or incomplete stream without inventing a terminal time", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "turn.started", { turnId: "turn-a" }, { turnId: "turn-a" }),
      event(
        1,
        "delivery.consumed",
        { deliveryId: "delivery-a", turnId: "turn-a" },
        { turnId: "turn-a" }
      ),
      event(
        2,
        "model.started",
        { runId: "run-a", turnId: "turn-a" },
        { runId: "run-a", turnId: "turn-a" }
      ),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([
      "delivery.settled",
      "turn.settled",
      "model.settled",
    ]);
    expect(result.stages.turn.endAt).toBeNull();
    expect(result.stages.turn.durationMs).toBeNull();
  });

  it("requires delivery settlement even after its turn has completed", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "turn.started", { turnId: "turn-a" }, { turnId: "turn-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(2, "turn.settled", {
        outcome: "completed",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["delivery.settled"]);
    expect(result.stages.delivery.settledDurationMs).toBeNull();
  });

  it.each([
    ["model.started", "model.settled", { runId: "run-a" }],
    ["call.requested", "call.settled", { callId: "call-a" }],
    ["interaction.opened", "interaction.settled", { interactionId: "input-a" }],
  ])("keeps an unfinished %s stage incomplete", (start, end, ids) => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(2, start, { ...ids, turnId: "turn-a" }),
      event(3, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(3, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual([end]);
  });

  it("requires a consumption event for a completed delivery", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(2, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["delivery.consumed"]);
  });

  it("does not invent model timings when correlation IDs are invalid", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "model.requested", {
        runId: "different=invalid",
        turnId: "turn-a",
      }),
      event(2, "model.started", { runId: "unsafe=value", turnId: "turn-a" }),
      event(3, "model.settled", { runId: "unsafe=value", turnId: "turn-a" }),
      event(4, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(4, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["model.settled"]);
    expect(result.stages.modelAttempts[0]?.durationMs).toBeNull();
    expect(result.stages.modelAttempts[0]?.requestedAt).toBeNull();
    expect(result.stages.modelAttempts[0]?.queueDurationMs).toBeNull();
  });

  it("reports model usage only when every numeric field is known", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.requested", { runId: "run-a", turnId: "turn-a" }),
      event(3, "model.started", {
        modelId: "openai/gpt-5-mini",
        provider: "openai",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(4, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageCacheReadText: "5",
        usageCacheWriteText: "6",
        usageCostText: "0.25",
        usageInputText: "100",
        usageKind: "model",
        usageOutputText: "20",
        usageOwnerRunId: "run-a",
      }),
      event(6, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(7, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(7, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage).toMatchObject({
      coverage: {
        attemptsWithoutUsage: 0,
        attemptsWithUsage: 1,
        completeRecords: 1,
        incomplete: false,
        observedRecords: 1,
      },
      totals: {
        cacheReadTokens: 5,
        cacheWriteTokens: 6,
        costUsd: 0.25,
        inputTokens: 100,
        outputTokens: 20,
      },
    });
    expect(result.stages.modelAttempts[0]).toMatchObject({
      modelId: "openai/gpt-5-mini",
      provider: "openai",
      queueDurationMs: 1000,
      turnToModelMs: 2000,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
      },
      usageComplete: true,
      usageRecordCount: 1,
    });
    const truncated = buildChatTraceTimeline(message, "session-1", rows, true);
    expect(truncated.usage.coverage.incomplete).toBe(true);
    expect(truncated.usage.totals).toBeNull();
    expect(truncated.usage.modelRuns).toHaveLength(1);
    const inFlight = buildChatTraceTimeline(
      message,
      "session-1",
      rows.filter((row) => row.type !== "delivery.settled")
    );
    expect(inFlight.complete).toBe(false);
    expect(inFlight.usage.coverage.incomplete).toBe(true);
    expect(inFlight.usage.totals).toBeNull();
  });

  it("deduplicates repeated usage rows and keeps partial totals honest", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
      event(3, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageInputText: "100",
        usageKind: "model",
        usageOwnerRunId: "run-a",
      }),
      event(4, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageInputText: "100",
        usageKind: "model",
        usageOutputText: "20",
        usageOwnerRunId: "run-a",
      }),
      event(5, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageKind: "model",
        usageOwnerRunId: "run-a",
      }),
      event(6, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(7, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(7, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage).toMatchObject({
      duplicateRecords: 2,
      incomplete: true,
      observedRecords: 3,
    });
    expect(result.usage.totals).toEqual({
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      inputTokens: 100,
      outputTokens: 20,
    });
    expect(result.stages.modelAttempts[0]).toMatchObject({
      usage: { inputTokens: 100, outputTokens: 20 },
      usageComplete: false,
      usageRecordCount: 3,
    });
  });

  it("keeps known token totals when provider cost is unavailable", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
      event(3, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
        usageOwnerRunId: "run-a",
      }),
      event(4, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(5, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(5, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage.incomplete).toBe(true);
    expect(result.usage.totals).toEqual({
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it.each([false, true])(
    "keeps totals unknown when a model run has no usage record (other known run: %s)",
    (includeKnownRun) => {
      const rows = [
        event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
        event(1, "delivery.consumed", {
          deliveryId: "delivery-a",
          turnId: "turn-a",
        }),
        event(1, "turn.started", { turnId: "turn-a" }),
        event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
        event(3, "model.settled", {
          outcome: "completed",
          runId: "run-a",
          turnId: "turn-a",
        }),
      ];
      if (includeKnownRun) {
        rows.push(
          event(4, "model.started", { runId: "run-b", turnId: "turn-a" }),
          event(5, "usage.recorded", {
            turnId: "turn-a",
            usageCacheReadText: "0",
            usageCacheWriteText: "0",
            usageCostText: "0.1",
            usageInputText: "10",
            usageKind: "model",
            usageOutputText: "5",
            usageOwnerRunId: "run-b",
          }),
          event(6, "model.settled", {
            outcome: "completed",
            runId: "run-b",
            turnId: "turn-a",
          })
        );
      }
      rows.push(
        event(7, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
        event(7, "delivery.settled", {
          deliveryId: "delivery-a",
          outcome: "handled",
          turnId: "turn-a",
        })
      );
      const result = buildChatTraceTimeline(message, "session-1", rows);
      expect(result.usage.coverage.incomplete).toBe(true);
      expect(result.usage.coverage.attemptsWithoutUsage).toBe(1);
      expect(result.usage.totals).toBeNull();
    }
  );

  it("does not promote a malformed call owner to model usage", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
      event(3, "usage.recorded", {
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageCostText: "0.1",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
        usageOwnerCallId: "malformed call owner",
        usageOwnerRunId: "run-a",
      }),
      event(4, "model.settled", { runId: "run-a", turnId: "turn-a" }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage.attributableRecords).toBe(0);
    expect(result.usage.coverage.unknownRecords).toBe(1);
    expect(result.usage.modelRuns[0]?.usage).toBeNull();
    expect(result.usage.totals).toBeNull();
  });

  it("does not attribute delegated, non-model or ownerless usage to a model run", () => {
    const usage = {
      usageCacheReadText: "1",
      usageCacheWriteText: "2",
      usageCostText: "0.1",
      usageInputText: "10",
      usageOutputText: "4",
    };
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
      event(3, "usage.recorded", {
        ...usage,
        runId: "run-a",
        turnId: "turn-a",
        usageKind: "model",
        usageOwnerCallId: "call-a",
      }),
      event(4, "usage.recorded", {
        ...usage,
        runId: "run-a",
        turnId: "turn-a",
        usageKind: "embedding",
        usageOwnerRunId: "run-a",
      }),
      event(5, "usage.recorded", {
        ...usage,
        runId: "run-a",
        turnId: "turn-a",
        usageKind: "model",
      }),
      event(6, "usage.recorded", {
        ...usage,
        runId: "run-a",
        turnId: "turn-a",
        usageKind: "model",
        usageOwnerRunId: "run-a",
      }),
      event(7, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(8, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(8, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage).toMatchObject({
      attributableRecords: 1,
      observedRecords: 4,
      unknownRecords: 3,
    });
    expect(result.usage.totals).toMatchObject({
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(result.usage.modelRuns[0]).toMatchObject({
      runId: "run-a",
      usageComplete: true,
    });
  });

  it("keeps usage on a unique model-run rollup when retries reuse a run id", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", {
        attempt: 0,
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(3, "model.retried", {
        attempt: 0,
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(4, "model.started", {
        attempt: 1,
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(5, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageCostText: "0.1",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
        usageOwnerRunId: "run-a",
      }),
      event(7, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(8, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(8, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage.ambiguousRuns).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.usage.totals).toBeNull();
    expect(result.usage.modelRuns).toMatchObject([
      { attemptCount: 2, runId: "run-a", usageComplete: true },
    ]);
    expect(
      result.stages.modelAttempts.every((attempt) => attempt.usage === null)
    ).toBe(true);
    expect(result.stages.modelAttempts).toMatchObject([
      { durationMs: 1000, outcome: "failed" },
      { durationMs: 3000, outcome: "completed" },
    ]);
    // SDK records can share a millisecond: durable line/index order still
    // identifies the retry and the last attempt that owns the run settlement.
    const sameTimestamp = rows.map((row) => ({ ...row, at: rows[0].at }));
    const tied = buildChatTraceTimeline(message, "session-1", sameTimestamp);
    expect(tied.complete).toBe(true);
    expect(tied.stages.modelAttempts).toMatchObject([
      { durationMs: 0, outcome: "failed" },
      { durationMs: 0, outcome: "completed" },
    ]);
    const missingRetry = buildChatTraceTimeline(
      message,
      "session-1",
      sameTimestamp.filter((row) => row.type !== "model.retried")
    );
    expect(missingRetry.complete).toBe(false);
    expect(missingRetry.stages.modelAttempts[0]?.endAt).toBeNull();
    expect(missingRetry.stages.modelAttempts[1]?.durationMs).toBe(0);
    expect(missingRetry.usage.totals).toBeNull();
  });

  it("does not match ownerless usage to a model with no run id", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { turnId: "turn-a" }),
      event(3, "usage.recorded", {
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageCostText: "0.1",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
      }),
      event(4, "model.settled", { outcome: "completed", turnId: "turn-a" }),
      event(5, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(5, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.stages.modelAttempts[0]).toMatchObject({
      runId: null,
      usage: null,
      usageRecordCount: 0,
    });
    expect(result.usage.coverage).toMatchObject({
      attemptsWithUsage: 0,
      observedRecords: 1,
      uniqueRuns: 0,
      unknownRecords: 1,
    });
    expect(result.usage.totals).toBeNull();
  });

  it("does not report complete totals when another model attempt lacks a run id", () => {
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(1, "turn.started", { turnId: "turn-a" }),
      event(2, "model.started", { runId: "run-a", turnId: "turn-a" }),
      event(3, "usage.recorded", {
        runId: "run-a",
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageCostText: "0.1",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
        usageOwnerRunId: "run-a",
      }),
      event(4, "model.started", { turnId: "turn-a" }),
      event(5, "usage.recorded", {
        turnId: "turn-a",
        usageCacheReadText: "0",
        usageCacheWriteText: "0",
        usageCostText: "0.1",
        usageInputText: "10",
        usageKind: "model",
        usageOutputText: "5",
      }),
      event(6, "model.settled", {
        outcome: "completed",
        runId: "run-a",
        turnId: "turn-a",
      }),
      event(7, "model.settled", { outcome: "completed", turnId: "turn-a" }),
      event(8, "turn.settled", { outcome: "completed", turnId: "turn-a" }),
      event(8, "delivery.settled", {
        deliveryId: "delivery-a",
        outcome: "handled",
        turnId: "turn-a",
      }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(result.usage.coverage.incomplete).toBe(true);
    expect(result.usage.coverage.attemptsWithoutUsage).toBe(1);
    expect(result.usage.totals).toBeNull();
  });

  it("does not emit prompt or error text through the logger", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logChatObservation("message.post", {
      errorCode: "password=secret",
      event: "ghp_metadata_canary_not_a_real_token",
      messageId: message.id,
      prompt: "password=secret",
      requestId: "iad1::abc",
    } as never);
    expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toEqual({
      event: "message.post",
      messageId: message.id,
      requestId: "iad1::abc",
      source: "busy.chat",
    });
    info.mockRestore();
  });

  it("keeps consultation failure outcomes in the allowlist", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logChatObservation("chat.persistence", {
      botSlug: "contracts",
      outcome: "consultation_failed",
      rowCount: 2,
      sessionId: "session-1",
    });
    expect(JSON.parse(info.mock.calls[0]?.[0] as string)).toMatchObject({
      event: "chat.persistence",
      outcome: "consultation_failed",
    });
    info.mockRestore();
  });

  it("does not expose arbitrary event labels or outcomes as metadata", () => {
    const canary = "ghp_metadata_canary_not_a_real_token";
    const rows = [
      event(0, "delivery.admitted", { deliveryId: "delivery-a" }),
      event(1, "delivery.consumed", {
        deliveryId: "delivery-a",
        turnId: "turn-a",
      }),
      event(2, "call.requested", { callId: "call-a", turnId: "turn-a" }),
      event(3, "call.settled", {
        callId: "call-a",
        outcome: canary,
        turnId: "turn-a",
      }),
      event(4, canary, { turnId: "turn-a" }),
    ];
    const result = buildChatTraceTimeline(message, "session-1", rows);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.eventWindow.eventCounts.unknown).toBe(1);
    expect(result.stages.tools[0]?.outcome).toBeNull();
  });

  it("accepts database SQLSTATEs but hides arbitrary exception names", () => {
    expect(errorCodeOf({ code: "22P05", message: "secret" })).toBe("22P05");
    expect(errorCodeOf(new Error("password=secret"))).toBe("Error");
    expect(errorCodeOf({ name: "password=secret" })).toBe("unknown");
  });
});
