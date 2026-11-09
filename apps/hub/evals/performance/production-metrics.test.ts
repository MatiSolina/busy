import { describe, expect, it } from "vitest";
import {
  isAllowedBot,
  isMessageId,
  isValidPreflightFailure,
  isValidSourceSample,
  syntheticPostAllowed,
} from "./production-config";
import {
  classifyEnrichmentSourceSample,
  preservePreflightFailure,
} from "./production-enrichment";
import {
  assertMetadataOnly,
  buildProductionSummary,
  distributionFor,
  markTraceIsolation,
  postOutcome,
  safeErrorCode,
  segmentKey,
  summarize,
  traceCompleteFromMetadata,
  tracePollFailure,
  usageMetadataFromTrace,
} from "./production-metrics";
import {
  classifySseClock,
  type SseProbeSnapshot,
} from "./production-sse-probe";

const sample = (patch: Partial<Parameters<typeof segmentKey>[0]> = {}) => ({
  ackWallMs: 40,
  bot: "qa-1104-operaciones-tokenpass",
  cacheReadCount: null,
  cacheWriteCount: null,
  costUsd: null,
  deliveryConsumedMs: 120,
  deliveryId: "delivery-1",
  deliverySettledMs: 500,
  deployment: "dpl-test",
  eventScanTruncated: false,
  failureCode: null,
  failurePhase: null,
  firstTokenVisibleMs: 60,
  firstVisibleMs: 100,
  inputCount: null,
  interactionCount: 0,
  mainThreadDiagnosticsStatus: "observed" as const,
  mainThreadTaskDurationDeltaMs: 30,
  messageId: "message-1",
  missingStages: [],
  model: "synthetic-model",
  modelRunCount: 1,
  outcome: "completed" as const,
  outputCount: null,
  provider: "tokenpass",
  qualityPassed: true,
  repeat: false,
  sessionId: "session-1",
  spanId: "span-1",
  sseClockStatus: "valid" as const,
  sseDroppedEventCount: 0,
  sseExactReplyMatch: true,
  sseFirstRelatedTextPartEventType: "content.delta",
  sseFirstRelatedTurnEventType: "turn.started",
  sseObservedEventCount: 3,
  sseOpenedAtMs: 800,
  sseOpenToRequestStartMs: 100,
  sseRequestStartedAtMs: 900,
  sseSessionAtMs: 820,
  sseSessionToRequestStartMs: 80,
  sseTargetPartId: "part-1",
  sseTargetTurnId: "turn-1",
  sseTextPartFullyVisibleStatus: "measured" as const,
  sseTextPartToFullyVisibleMs: 20,
  sseTimeOriginMs: 100_000,
  sseTurnFullyVisibleStatus: "measured" as const,
  sseTurnToFullyVisibleMs: 30,
  toolCallCount: 0,
  traceComplete: true,
  traceCorrelated: true,
  traceId: "trace-1",
  traceIsolated: true,
  traceObservationMs: 300,
  turnDurationMs: 500,
  turnId: "turn-1",
  usageCoverage: null,
  usageModelRuns: [],
  ...patch,
});

describe("production performance statistics", () => {
  it("calculates p50/p95 and keeps failed attempts in the denominator", () => {
    expect(summarize([10, 20, 30], 1)).toEqual({
      count: 4,
      failureRate: 0.25,
      failures: 1,
      p50: 20,
      p95: 30,
    });
  });

  it("counts missing values as failed observations", () => {
    expect(
      distributionFor(
        [sample({ firstVisibleMs: null }), sample({ firstVisibleMs: 40 })],
        "firstVisibleMs"
      )
    ).toMatchObject({ count: 2, failures: 1, p50: 40, p95: 40 });
  });

  it("summarizes first-token visibility globally and per segment", () => {
    const summary = buildProductionSummary([
      sample({ firstTokenVisibleMs: 20 }),
      sample({ firstTokenVisibleMs: 80 }),
      sample({ firstTokenVisibleMs: null }),
    ]);
    expect(summary.latency.firstTokenVisibleMs).toMatchObject({
      count: 3,
      failures: 1,
      p50: 20,
      p95: 80,
    });
    expect(summary.segments[0]?.firstTokenVisibleMs).toEqual(
      summary.latency.firstTokenVisibleMs
    );
    expect(() => assertMetadataOnly({ firstTokenVisibleMs: "text" })).toThrow(
      "metadata_numeric_invalid"
    );
  });

  it("segments by bot, provider, model and initial/repeat phase", () => {
    expect(segmentKey(sample({ repeat: true }))).toBe(
      "qa-1104-operaciones-tokenpass|tokenpass|synthetic-model|repeat"
    );
    expect(
      buildProductionSummary([sample(), sample({ repeat: true })]).segments
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          segment:
            "qa-1104-operaciones-tokenpass|tokenpass|synthetic-model|initial",
        }),
      ])
    );
  });

  it("rejects content-shaped metadata keys", () => {
    expect(() =>
      assertMetadataOnly({ ackWallMs: 3, status: "failed" })
    ).not.toThrow();
    expect(() => assertMetadataOnly({ prompt: "never write this" })).toThrow();
    expect(() =>
      assertMetadataOnly({ nested: [{ signedUrl: "never" }] })
    ).toThrow();
    expect(() =>
      assertMetadataOnly(buildProductionSummary([sample()]))
    ).not.toThrow();
    expect(() => assertMetadataOnly({ samples: [sample()] })).not.toThrow();
    expect(
      safeErrorCode(
        Object.assign(new Error("fixture"), { name: "secret-value" })
      )
    ).toBe("Error");
  });

  it("parses the nested trace usage totals and per-model metadata", () => {
    expect(
      usageMetadataFromTrace({
        stages: {
          modelAttempts: [
            {
              durationMs: 90,
              queueDurationMs: 12,
              requestedAt: "2026-11-04T18:00:00.000Z",
              runId: "run_0",
            },
            { durationMs: 50, runId: "run_1" },
            { durationMs: 60, runId: "run_1" },
          ],
        },
        usage: {
          coverage: { incomplete: false },
          modelRuns: [
            { modelId: "openai/gpt-5", provider: null, runId: "run_0" },
            { modelId: "openai/gpt-5-mini", runId: "run_1" },
          ],
          totals: {
            cacheReadTokens: 4,
            cacheWriteTokens: 2,
            costUsd: 0.01,
            inputTokens: 12,
            outputTokens: 3,
          },
        },
      })
    ).toEqual({
      coverage: "complete",
      modelRuns: [
        {
          attemptCount: 1,
          durationMs: 90,
          modelId: "openai/gpt-5",
          provider: null,
          queueDurationMs: 12,
          requestedAt: "2026-11-04T18:00:00.000Z",
          runId: "run_0",
        },
        {
          attemptCount: 2,
          durationMs: null,
          modelId: "openai/gpt-5-mini",
          provider: null,
          queueDurationMs: null,
          requestedAt: null,
          runId: "run_1",
        },
      ],
      totals: {
        cacheReadCount: 4,
        cacheWriteCount: 2,
        costUsd: 0.01,
        inputCount: 12,
        outputCount: 3,
      },
    });
    expect(
      usageMetadataFromTrace({ usage: { coverage: { incomplete: true } } })
        .coverage
    ).toBe("partial");
    expect(usageMetadataFromTrace({ usage: {} }).coverage).toBeNull();
  });

  it("labels missing and inconsistent same-document SSE clocks", () => {
    const snapshot = (patch: Partial<SseProbeSnapshot> = {}) => ({
      droppedEvents: 0,
      events: [],
      exactReplyMatch: true,
      matchedReplyCount: 1,
      observedEventCount: 1,
      openedAtMs: 10,
      requestStartedAtMs: 30,
      sessionAtMs: 20,
      sessionId: null,
      targetPartId: "part-1",
      targetTurnId: "turn-1",
      timeOriginMs: 1000,
      ...patch,
    });
    expect(classifySseClock(snapshot())).toBe("valid");
    expect(
      classifySseClock(
        snapshot({ openedAtMs: 30, requestStartedAtMs: 10, sessionAtMs: 40 })
      )
    ).toBe("valid");
    expect(classifySseClock(snapshot({ requestStartedAtMs: -1 }))).toBe(
      "inconsistent"
    );
    expect(classifySseClock(snapshot({ timeOriginMs: Number.NaN }))).toBe(
      "inconsistent"
    );
    expect(classifySseClock(snapshot({ sessionAtMs: null }))).toBe("missing");
  });

  it("fails closed for posts and validates enrichment trace metadata", () => {
    expect(syntheticPostAllowed("1")).toBe(true);
    expect(syntheticPostAllowed(undefined)).toBe(false);
    expect(isAllowedBot("qa-1104-operaciones-tokenpass")).toBe(true);
    expect(isAllowedBot("not-allowlisted")).toBe(false);
    expect(isMessageId("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isMessageId("not-a-uuid")).toBe(false);
    expect(
      isValidSourceSample({
        bot: "qa-1104-operaciones-tokenpass",
        messageId: "11111111-1111-4111-8111-111111111111",
      })
    ).toBe(true);
    expect(
      isValidSourceSample({ bot: "not-allowlisted", messageId: "not-a-uuid" })
    ).toBe(false);
    const traceable = {
      bot: "qa-1104-operaciones-tokenpass",
      messageId: "11111111-1111-4111-8111-111111111111",
    };
    const preflightFailure = {
      bot: "qa-1104-operaciones-gateway",
      failureCode: "preflight_failed",
      failurePhase: "stream_ready",
      messageId: null,
      outcome: "failed",
    };
    expect(isValidPreflightFailure(preflightFailure)).toBe(true);
    expect(
      isValidPreflightFailure({
        ...preflightFailure,
        outcome: "completed",
      })
    ).toBe(false);
    expect(
      isValidPreflightFailure({
        ...preflightFailure,
        failurePhase: { raw: "not-a-phase" },
        messageId: null,
      })
    ).toBe(false);
    const mixed = [traceable, preflightFailure].map(
      classifyEnrichmentSourceSample
    );
    expect(mixed).toEqual([
      { kind: "trace", sample: traceable },
      { kind: "preflight_failure", sample: preflightFailure },
    ]);
    const preserved = mixed.flatMap((entry) =>
      entry?.kind === "preflight_failure"
        ? [preservePreflightFailure(entry.sample)]
        : [{ outcome: "observed" }]
    );
    expect(preserved).toHaveLength(2);
    expect(
      preserved.filter((entry) => entry.outcome === "failed")
    ).toHaveLength(1);
    const completeTrace = {
      complete: true,
      eventWindow: { scanTruncated: false },
      missing: [],
    };
    expect(traceCompleteFromMetadata(completeTrace)).toBe(true);
    expect(
      traceCompleteFromMetadata({
        ...completeTrace,
        eventWindow: { scanTruncated: true },
      })
    ).toBe(false);
    expect(
      traceCompleteFromMetadata({ ...completeTrace, missing: ["turn.settled"] })
    ).toBe(false);
  });

  it("keeps aborted POSTs in the timeout denominator", () => {
    expect(postOutcome(0)).toBe("timeout");
    expect(postOutcome(500)).toBe("failed");
  });

  it("keeps trace deadlines distinct from completed-trace validation", () => {
    expect(tracePollFailure(true, true)).toEqual({
      failureCode: "trace_timeout",
      failurePhase: "trace_poll",
      outcome: "timeout",
    });
    expect(tracePollFailure(true, false)).toEqual({
      failureCode: "trace_timeout",
      failurePhase: "trace_poll",
      outcome: "timeout",
    });
    expect(tracePollFailure(false, false)).toEqual({
      failureCode: "trace_incomplete",
      failurePhase: "trace_poll",
      outcome: "failed",
    });
    // A completed-but-invalid trace must continue through trace_validation.
    expect(tracePollFailure(false, true)).toBeNull();

    const summary = buildProductionSummary([
      sample({ failureCode: "trace_validation", outcome: "failed" }),
      sample({
        eventScanTruncated: false,
        failureCode: "trace_timeout",
        firstVisibleMs: null,
        outcome: "timeout",
        traceComplete: false,
        traceObservationMs: null,
      }),
    ]);
    expect(summary).toMatchObject({
      completed: 0,
      failed: 1,
      samples: 2,
      timedOut: 1,
      traceComplete: 1,
    });
    expect(summary.latency.traceObservationMs).toMatchObject({
      count: 2,
      failures: 1,
    });
  });

  it("namespaces local run counters by session and rejects repeats in one session", () => {
    const previous = new Set<string>();
    expect(
      markTraceIsolation(
        {
          callIds: [],
          interactionIds: [],
          modelRunIds: ["run_0"],
          sessionId: "session-a",
        },
        previous
      )
    ).toBe(true);
    expect(
      markTraceIsolation(
        {
          callIds: [],
          interactionIds: [],
          modelRunIds: ["run_0"],
          sessionId: "session-b",
        },
        previous
      )
    ).toBe(true);
    expect(
      markTraceIsolation(
        {
          callIds: [],
          interactionIds: [],
          modelRunIds: ["run_0"],
          sessionId: "session-a",
        },
        previous
      )
    ).toBe(false);
  });
});
