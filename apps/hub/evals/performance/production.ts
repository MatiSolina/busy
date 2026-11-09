import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Page } from "@playwright/test";
import {
  type AllowedBot,
  BOT_PROVIDERS,
  DEFAULT_BOTS,
  syntheticPostAllowed,
} from "./production-config";
import {
  beginMainThreadSample,
  installMainThreadDiagnostics,
  type MainThreadController,
  type MainThreadSnapshot,
  stopMainThreadSample,
} from "./production-main-thread";
import {
  assertMetadataOnly,
  buildProductionSummary,
  markTraceIsolation,
  type ProductionSample,
  postOutcome,
  safeErrorCode,
  tracePollFailure,
  type UsageMetadata,
  usageMetadataFromTrace,
} from "./production-metrics";
import {
  classifySseClock,
  correlateSseToFullyVisible,
  installSseLatencyProbe,
  markSseRequestStart,
  type ReplyPartResolution,
  resolveExactReplyPart,
  type SseProbeSnapshot,
  stopSseLatencyProbe,
  waitForSseLatencyReadiness,
} from "./production-sse-probe";
import {
  beginVisibilityObservation,
  finishVisibilityObservation,
  waitForVisibilityReadiness,
} from "./production-visibility";

const PROD_ORIGIN = "https://app.busybot.dev";
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/u;
const TRAILING_SLASH = /\/$/u;
const SAFE_LABEL = /^[A-Za-z0-9._:-]{1,128}$/u;
const TRACE_ID = /^[0-9a-f]{32}$/iu;
const SPAN_ID = /^[0-9a-f]{16}$/iu;

interface TraceSummary {
  complete: boolean;
  correlation: {
    callIds: string[];
    deliveryId: string | null;
    interactionIds: string[];
    modelRunIds: string[];
    sessionId: string | null;
    spanId: string | null;
    traceId: string | null;
    turnId: string | null;
  };
  eventWindow: { scanTruncated: boolean };
  messageId: string | null;
  missing: string[];
  stages: {
    delivery: {
      consumedDurationMs: number | null;
      settledDurationMs: number | null;
    };
    modelAttempts: Array<{ durationMs: number | null; runId: string | null }>;
    tools: Array<{ callId: string | null; durationMs: number | null }>;
    turn: { durationMs: number | null; outcome: string | null };
  };
  usage: UsageMetadata;
}

interface BotMetadata {
  billing: string | null;
  model: string | null;
}

interface ProductionReport {
  deployment: string | null;
  generatedAt: string;
  harness: {
    origin: string;
    runtime: "chromium";
    samplesPerBot: number;
    timeoutMs: number;
    variant: string;
  };
  samples: ProductionSample[];
  summary: ReturnType<typeof buildProductionSummary>;
}

let activePhase = "config";

async function writeFailureEnvelope(
  output: string,
  phase: string,
  error: unknown,
  samples: ProductionSample[] = []
): Promise<void> {
  const safeSamples = samples.map((sample) => ({
    bot: sample.bot,
    failureCode: "measurement_failed",
    failurePhase: phase,
    messageId: sample.messageId,
    outcome: "failed" as const,
  }));
  const envelope = {
    generatedAt: new Date().toISOString(),
    phase,
    samples: safeSamples,
    status: "failed",
    summary: {
      completed: 0,
      failed: safeSamples.length,
      samples: safeSamples.length,
      timedOut: 0,
      traceComplete: 0,
    },
  };
  assertMetadataOnly(envelope);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stderr.write(
    `${JSON.stringify({
      errorCode: safeErrorCode(error),
      output,
      phase,
      status: "failed",
    })}\n`
  );
}

function envNumber(
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const value = Number(process.env[name] ?? fallback);
  assert(
    Number.isInteger(value) && value >= min && value <= max,
    `${name} is out of range`
  );
  return value;
}

function originFromEnv(): string {
  const origin = process.env.PROD_PERF_ORIGIN ?? PROD_ORIGIN;
  const parsed = new URL(origin);
  assert(
    parsed.pathname === "" || parsed.pathname === "/",
    "Origin must not include a path"
  );
  assert(
    parsed.protocol === "https:"
      ? origin === PROD_ORIGIN
      : LOOPBACK_ORIGIN.test(origin),
    "Origin is not allowlisted"
  );
  return origin.replace(TRAILING_SLASH, "");
}

function selectedBots(): AllowedBot[] {
  const raw =
    process.env.PROD_PERF_BOTS?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? DEFAULT_BOTS;
  assert(
    raw.length > 0 && raw.length <= DEFAULT_BOTS.length,
    "PROD_PERF_BOTS is out of range"
  );
  for (const slug of raw) {
    assert(slug in BOT_PROVIDERS, `Bot is not allowlisted: ${slug}`);
  }
  return raw as AllowedBot[];
}

function label(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;
  assert(SAFE_LABEL.test(value), `${name} contains unsafe metadata`);
  return value;
}

async function jsonRequest(
  page: Page,
  requestPath: string,
  requestInit?: RequestInit,
  timeoutMs = 15_000
): Promise<{ status: number; body: unknown }> {
  return await page.evaluate(
    async ({ init, path, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(path, {
          ...init,
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json().catch(() => null);
        return { body, status: response.status };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return { body: null, status: 0 };
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    { init: requestInit, path: requestPath, timeout: timeoutMs }
  );
}

function metadataFromBot(body: unknown): BotMetadata {
  if (!body || typeof body !== "object") {
    return { billing: null, model: null };
  }
  const value = body as { billing?: unknown; model?: unknown };
  return {
    billing: typeof value.billing === "string" ? value.billing : null,
    model: typeof value.model === "string" ? value.model : null,
  };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && SAFE_LABEL.test(item)
      )
    : [];
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && SAFE_LABEL.test(value) ? value : null;
}

function safeTraceId(value: unknown): string | null {
  return typeof value === "string" && TRACE_ID.test(value) ? value : null;
}

function safeSpanId(value: unknown): string | null {
  return typeof value === "string" && SPAN_ID.test(value) ? value : null;
}

function traceSummary(body: unknown): TraceSummary | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const trace = body as Record<string, unknown>;
  const correlation = (trace.correlation ?? {}) as Record<string, unknown>;
  const stages = (trace.stages ?? {}) as Record<string, unknown>;
  const delivery = (stages.delivery ?? {}) as Record<string, unknown>;
  const turn = (stages.turn ?? {}) as Record<string, unknown>;
  const usage = usageMetadataFromTrace(trace);
  const attempts = Array.isArray(stages.modelAttempts)
    ? stages.modelAttempts
    : [];
  const tools = Array.isArray(stages.tools) ? stages.tools : [];
  return {
    complete: trace.complete === true,
    correlation: {
      callIds: ids(correlation.callIds),
      deliveryId: safeId(correlation.deliveryId),
      interactionIds: ids(correlation.interactionIds),
      modelRunIds: ids(correlation.modelRunIds),
      sessionId: safeId(correlation.sessionId),
      spanId: safeSpanId(correlation.spanId),
      traceId: safeTraceId(correlation.traceId),
      turnId: safeId(correlation.turnId),
    },
    eventWindow: {
      scanTruncated:
        (trace.eventWindow as { scanTruncated?: unknown } | undefined)
          ?.scanTruncated === true,
    },
    messageId: safeId((trace.message as { id?: unknown } | undefined)?.id),
    missing: Array.isArray(trace.missing)
      ? trace.missing.filter((item): item is string => typeof item === "string")
      : [],
    stages: {
      delivery: {
        consumedDurationMs: numeric(delivery.consumedDurationMs),
        settledDurationMs: numeric(delivery.settledDurationMs),
      },
      modelAttempts: attempts.map((attempt) => {
        const value = (attempt ?? {}) as Record<string, unknown>;
        return {
          durationMs: numeric(value.durationMs),
          runId: typeof value.runId === "string" ? value.runId : null,
        };
      }),
      tools: tools.map((tool) => {
        const value = (tool ?? {}) as Record<string, unknown>;
        return {
          callId: typeof value.callId === "string" ? value.callId : null,
          durationMs: numeric(value.durationMs),
        };
      }),
      turn: {
        durationMs: numeric(turn.durationMs),
        outcome: typeof turn.outcome === "string" ? turn.outcome : null,
      },
    },
    usage,
  };
}

function traceMetadata(
  sample: ProductionSample,
  trace: TraceSummary
): ProductionSample {
  return {
    ...sample,
    cacheReadCount: trace.usage.totals.cacheReadCount,
    cacheWriteCount: trace.usage.totals.cacheWriteCount,
    costUsd: trace.usage.totals.costUsd,
    deliveryConsumedMs: trace.stages.delivery.consumedDurationMs,
    deliveryId: trace.correlation.deliveryId,
    deliverySettledMs: trace.stages.delivery.settledDurationMs,
    eventScanTruncated: trace.eventWindow.scanTruncated,
    inputCount: trace.usage.totals.inputCount,
    interactionCount: trace.correlation.interactionIds.length,
    messageId: trace.messageId,
    missingStages: trace.missing,
    modelRunCount: trace.correlation.modelRunIds.length,
    outputCount: trace.usage.totals.outputCount,
    qualityPassed: sample.qualityPassed,
    sessionId: trace.correlation.sessionId,
    spanId: trace.correlation.spanId,
    toolCallCount: trace.correlation.callIds.length,
    traceComplete:
      trace.complete &&
      !trace.eventWindow.scanTruncated &&
      trace.missing.length === 0,
    traceCorrelated: sample.traceCorrelated,
    traceId: trace.correlation.traceId,
    traceIsolated: sample.traceIsolated,
    turnDurationMs: trace.stages.turn.durationMs,
    turnId: trace.correlation.turnId,
    usageCoverage: trace.usage.coverage,
    usageModelRuns: trace.usage.modelRuns,
  };
}

type SseSampleFields = Pick<
  ProductionSample,
  | "sseClockStatus"
  | "sseDroppedEventCount"
  | "sseExactReplyMatch"
  | "sseFirstRelatedTextPartEventType"
  | "sseFirstRelatedTurnEventType"
  | "sseOpenToRequestStartMs"
  | "sseObservedEventCount"
  | "sseOpenedAtMs"
  | "sseRequestStartedAtMs"
  | "sseSessionAtMs"
  | "sseSessionToRequestStartMs"
  | "sseTargetPartId"
  | "sseTargetTurnId"
  | "sseTextPartFullyVisibleStatus"
  | "sseTextPartToFullyVisibleMs"
  | "sseTimeOriginMs"
  | "sseTurnFullyVisibleStatus"
  | "sseTurnToFullyVisibleMs"
>;

const EMPTY_SSE_FIELDS: SseSampleFields = {
  sseClockStatus: "missing",
  sseDroppedEventCount: 0,
  sseExactReplyMatch: false,
  sseFirstRelatedTextPartEventType: null,
  sseFirstRelatedTurnEventType: null,
  sseObservedEventCount: 0,
  sseOpenedAtMs: null,
  sseOpenToRequestStartMs: null,
  sseRequestStartedAtMs: null,
  sseSessionAtMs: null,
  sseSessionToRequestStartMs: null,
  sseTargetPartId: null,
  sseTargetTurnId: null,
  sseTextPartFullyVisibleStatus: "missing_event",
  sseTextPartToFullyVisibleMs: null,
  sseTimeOriginMs: null,
  sseTurnFullyVisibleStatus: "missing_event",
  sseTurnToFullyVisibleMs: null,
};

function nonNegativeDelta(
  later: number | null,
  earlier: number | null
): number | null {
  if (later === null || earlier === null || later < earlier) {
    return null;
  }
  return later - earlier;
}

function sseSampleFields(
  snapshot: SseProbeSnapshot,
  resolution: ReplyPartResolution,
  turnId: string | null,
  firstVisibleAtMs: number | null
): SseSampleFields {
  const targetPartId = resolution.targetPartId ?? snapshot.targetPartId;
  const targetTurnId = resolution.targetTurnId ?? turnId;
  const fullyVisible = correlateSseToFullyVisible(
    snapshot,
    { partId: targetPartId, turnId: targetTurnId },
    firstVisibleAtMs
  );
  const clockStatus = classifySseClock(snapshot);
  return {
    sseClockStatus: clockStatus,
    sseDroppedEventCount: snapshot.droppedEvents,
    sseExactReplyMatch:
      snapshot.exactReplyMatch &&
      resolution.exactReplyMatch &&
      (turnId === null || resolution.targetTurnId === turnId),
    sseFirstRelatedTextPartEventType:
      fullyVisible.firstRelatedTextPartEventType,
    sseFirstRelatedTurnEventType: fullyVisible.firstRelatedTurnEventType,
    sseObservedEventCount: snapshot.observedEventCount,
    sseOpenedAtMs: snapshot.openedAtMs,
    sseOpenToRequestStartMs:
      clockStatus === "valid"
        ? nonNegativeDelta(snapshot.requestStartedAtMs, snapshot.openedAtMs)
        : null,
    sseRequestStartedAtMs: snapshot.requestStartedAtMs,
    sseSessionAtMs: snapshot.sessionAtMs,
    sseSessionToRequestStartMs:
      clockStatus === "valid"
        ? nonNegativeDelta(snapshot.requestStartedAtMs, snapshot.sessionAtMs)
        : null,
    sseTargetPartId: targetPartId,
    sseTargetTurnId: resolution.targetTurnId,
    sseTextPartFullyVisibleStatus: fullyVisible.textPartFullyVisibleStatus,
    sseTextPartToFullyVisibleMs: fullyVisible.textPartToFullyVisibleMs,
    sseTimeOriginMs: snapshot.timeOriginMs,
    sseTurnFullyVisibleStatus: fullyVisible.turnFullyVisibleStatus,
    sseTurnToFullyVisibleMs: fullyVisible.turnToFullyVisibleMs,
  };
}

function sseProbeValid(fields: SseSampleFields): boolean {
  return (
    fields.sseDroppedEventCount === 0 &&
    fields.sseExactReplyMatch &&
    fields.sseClockStatus === "valid" &&
    fields.sseTextPartFullyVisibleStatus === "measured"
  );
}

type MainThreadSampleFields = Pick<
  ProductionSample,
  "mainThreadDiagnosticsStatus" | "mainThreadTaskDurationDeltaMs"
>;

const EMPTY_MAIN_THREAD_FIELDS: MainThreadSampleFields = {
  mainThreadDiagnosticsStatus: "unavailable",
  mainThreadTaskDurationDeltaMs: null,
};

function mainThreadSampleFields(
  snapshot: MainThreadSnapshot
): MainThreadSampleFields {
  return {
    mainThreadDiagnosticsStatus: snapshot.supported
      ? "observed"
      : "unsupported",
    mainThreadTaskDurationDeltaMs: snapshot.taskDurationDeltaMs,
  };
}

async function postMessage(
  page: Page,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ ackWallMs: number; body: unknown; status: number }> {
  return await page.evaluate(
    async ({ body: payload, path: requestPath, timeout }) => {
      const started = performance.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(requestPath, {
          body: JSON.stringify(payload),
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        return {
          ackWallMs: performance.now() - started,
          body: await response.json().catch(() => null),
          status: response.status,
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return {
            ackWallMs: performance.now() - started,
            body: null,
            status: 0,
          };
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    { body, path, timeout: timeoutMs }
  );
}

async function pollTrace(
  page: Page,
  slug: string,
  messageId: string,
  timeoutMs: number
): Promise<{
  deadlineExpired: boolean;
  durationMs: number;
  trace: TraceSummary | null;
}> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let last: TraceSummary | null = null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Trace polling must remain sequential so each request observes the latest persisted state.
    const response = await jsonRequest(
      page,
      `/api/bots/${encodeURIComponent(slug)}/messages/${messageId}/trace`,
      undefined,
      Math.min(10_000, remainingMs)
    );
    last = traceSummary(response.body);
    if (response.status === 200 && last?.complete) {
      return {
        deadlineExpired: false,
        durationMs: Date.now() - started,
        trace: last,
      };
    }
    const sleepMs = Math.min(1000, deadline - Date.now());
    if (sleepMs <= 0) {
      break;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, sleepMs));
  }
  return {
    deadlineExpired: true,
    durationMs: Date.now() - started,
    trace: last,
  };
}

async function waitForBrowserReadyAfterTrace(
  page: Page,
  tracePresent: boolean,
  timeoutMs: number
): Promise<boolean> {
  if (!tracePresent) {
    return false;
  }
  try {
    await waitForVisibilityReadiness(page, Math.min(15_000, timeoutMs));
    return true;
  } catch {
    return false;
  }
}

function browserQualityPassed(
  visibility: { qualityPassed: boolean },
  browserReady: boolean
): boolean {
  return visibility.qualityPassed && browserReady;
}

async function runSample(
  page: Page,
  slug: AllowedBot,
  metadata: BotMetadata,
  repeat: boolean,
  timeoutMs: number,
  deployment: string | null,
  previousIds: Set<string>,
  mainThread: MainThreadController
): Promise<ProductionSample> {
  const messageId = randomUUID();
  const marker = `BUSY_PROD_PERF_${randomUUID().replaceAll("-", "")}`;
  const prompt = `This is a synthetic Busy performance measurement. Respond with exactly ${marker} and nothing else. Do not call tools, read files, or perform external actions.`;
  const base: ProductionSample = {
    ackWallMs: null,
    bot: slug,
    cacheReadCount: null,
    cacheWriteCount: null,
    costUsd: null,
    deliveryConsumedMs: null,
    deliveryId: null,
    deliverySettledMs: null,
    deployment,
    eventScanTruncated: false,
    failureCode: null,
    failurePhase: null,
    firstTokenVisibleMs: null,
    firstVisibleMs: null,
    inputCount: null,
    interactionCount: 0,
    messageId,
    missingStages: [],
    model: metadata.model,
    modelRunCount: 0,
    outcome: "failed",
    outputCount: null,
    provider: metadata.billing ?? BOT_PROVIDERS[slug],
    qualityPassed: false,
    repeat,
    sessionId: null,
    spanId: null,
    toolCallCount: 0,
    traceComplete: false,
    traceCorrelated: false,
    traceId: null,
    traceIsolated: false,
    traceObservationMs: null,
    turnDurationMs: null,
    turnId: null,
    ...EMPTY_MAIN_THREAD_FIELDS,
    ...EMPTY_SSE_FIELDS,
    usageCoverage: null,
    usageModelRuns: [],
  };
  let probeStopped = false;
  const stopProbe = async (
    resolution: ReplyPartResolution,
    turnId: string | null,
    firstVisibleAtMs: number | null
  ): Promise<SseSampleFields> => {
    if (probeStopped) {
      return EMPTY_SSE_FIELDS;
    }
    try {
      const snapshot = await stopSseLatencyProbe(page);
      probeStopped = true;
      return sseSampleFields(snapshot, resolution, turnId, firstVisibleAtMs);
    } catch {
      probeStopped = true;
      return EMPTY_SSE_FIELDS;
    }
  };
  const stopMainThread = async (): Promise<MainThreadSampleFields> => {
    try {
      const snapshot = await stopMainThreadSample(mainThread);
      return mainThreadSampleFields(snapshot);
    } catch {
      return EMPTY_MAIN_THREAD_FIELDS;
    }
  };
  const stopMeasurements = async (
    resolution: ReplyPartResolution,
    turnId: string | null,
    firstVisibleAtMs: number | null
  ): Promise<SseSampleFields & MainThreadSampleFields> => ({
    ...(await stopProbe(resolution, turnId, firstVisibleAtMs)),
    ...(await stopMainThread()),
  });
  await beginVisibilityObservation(page, marker);
  try {
    // This is the final monotonic timestamp operation immediately before the
    // single bounded POST; never retry the POST after a timeout.
    await beginMainThreadSample(mainThread);
    await markSseRequestStart(page, marker);
    const posted = await postMessage(
      page,
      `/api/bots/${encodeURIComponent(slug)}/messages`,
      {
        clientContext: { timeZone: "UTC" },
        fileIds: [],
        id: messageId,
        text: prompt,
      },
      Math.min(15_000, timeoutMs)
    );
    const { ackWallMs } = posted;
    const deliveryId =
      posted.body &&
      typeof posted.body === "object" &&
      typeof (posted.body as { deliveryId?: unknown }).deliveryId === "string"
        ? (posted.body as { deliveryId: string }).deliveryId
        : null;
    const attempted = { ...base, ackWallMs, deliveryId };
    if (posted.status < 200 || posted.status >= 300 || !deliveryId) {
      const visibility = await finishVisibilityObservation(page);
      const resolution = await resolveExactReplyPart(page).catch(() => ({
        exactReplyMatch: false,
        targetPartId: null,
        targetTurnId: null,
      }));
      const measurementFields = await stopMeasurements(
        resolution,
        null,
        visibility.firstVisibleAtMs
      );
      return {
        ...attempted,
        failureCode: posted.status === 0 ? "timeout" : `http_${posted.status}`,
        failurePhase: "post",
        firstTokenVisibleMs: visibility.firstTokenVisibleMs,
        firstVisibleMs: visibility.firstVisibleMs,
        outcome: postOutcome(posted.status),
        qualityPassed: visibility.qualityPassed,
        ...measurementFields,
      };
    }
    const traceResult = await pollTrace(page, slug, messageId, timeoutMs);
    const browserReady = await waitForBrowserReadyAfterTrace(
      page,
      Boolean(traceResult.trace) && !traceResult.deadlineExpired,
      timeoutMs
    );
    const visibility = await finishVisibilityObservation(page);
    const resolution = await resolveExactReplyPart(page).catch(() => ({
      exactReplyMatch: false,
      targetPartId: null,
      targetTurnId: null,
    }));
    const pollFailure = tracePollFailure(
      traceResult.deadlineExpired,
      Boolean(traceResult.trace)
    );
    if (pollFailure) {
      const measurementFields = await stopMeasurements(
        resolution,
        null,
        visibility.firstVisibleAtMs
      );
      return {
        ...attempted,
        ...pollFailure,
        firstTokenVisibleMs: visibility.firstTokenVisibleMs,
        firstVisibleMs: visibility.firstVisibleMs,
        qualityPassed: visibility.qualityPassed,
        traceObservationMs: traceResult.durationMs,
        ...measurementFields,
      };
    }
    assert(traceResult.trace);
    const { trace } = traceResult;
    const measurementFields = await stopMeasurements(
      resolution,
      trace.correlation.turnId,
      visibility.firstVisibleAtMs
    );
    const correlated =
      trace.messageId === messageId &&
      trace.correlation.deliveryId === deliveryId;
    const isolated = markTraceIsolation(trace.correlation, previousIds);
    const qualityPassed = browserQualityPassed(visibility, browserReady);
    const validCorrelation = Boolean(
      trace.correlation.sessionId &&
        trace.correlation.turnId &&
        trace.correlation.traceId &&
        trace.correlation.spanId
    );
    const noActions =
      trace.correlation.callIds.length === 0 &&
      trace.correlation.interactionIds.length === 0;
    const completed =
      trace.complete &&
      correlated &&
      qualityPassed &&
      sseProbeValid(measurementFields) &&
      isolated &&
      validCorrelation &&
      noActions &&
      trace.stages.turn.outcome === "completed";
    return traceMetadata(
      {
        ...attempted,
        failureCode: completed ? null : "trace_validation",
        failurePhase: completed ? null : "trace_validation",
        firstTokenVisibleMs: visibility.firstTokenVisibleMs,
        firstVisibleMs: visibility.firstVisibleMs,
        outcome: completed ? "completed" : "failed",
        qualityPassed,
        traceCorrelated: correlated,
        traceIsolated: isolated,
        traceObservationMs: traceResult.durationMs,
        ...measurementFields,
      },
      trace
    );
  } catch {
    const visibility = await finishVisibilityObservation(page).catch(() => ({
      firstTokenVisibleAtMs: null,
      firstTokenVisibleMs: null,
      firstVisibleAtMs: null,
      firstVisibleMs: null,
      qualityPassed: false,
    }));
    const resolution = await resolveExactReplyPart(page).catch(() => ({
      exactReplyMatch: false,
      targetPartId: null,
      targetTurnId: null,
    }));
    const measurementFields = await stopMeasurements(
      resolution,
      null,
      visibility.firstVisibleAtMs
    );
    return {
      ...base,
      failureCode: "exception",
      failurePhase: "sample",
      firstTokenVisibleMs: visibility.firstTokenVisibleMs,
      firstVisibleMs: visibility.firstVisibleMs,
      qualityPassed: visibility.qualityPassed,
      ...measurementFields,
    };
  } finally {
    if (!probeStopped) {
      await stopSseLatencyProbe(page).catch(() => undefined);
      probeStopped = true;
    }
    await stopMainThreadSample(mainThread).catch(() => undefined);
  }
}

async function runMain() {
  activePhase = "config";
  assert(
    syntheticPostAllowed(process.env.PROD_PERF_ALLOW_SYNTHETIC_POST),
    "PROD_PERF_ALLOW_SYNTHETIC_POST=1 is required for synthetic POSTs"
  );
  const origin = originFromEnv();
  const storageState = process.env.PROD_PERF_STORAGE_STATE;
  assert(
    storageState,
    "PROD_PERF_STORAGE_STATE is required; use an existing authenticated state file"
  );
  activePhase = "storage_state";
  await access(resolve(storageState));
  const bots = selectedBots();
  const samplesPerBot = envNumber("PROD_PERF_SAMPLES", 1, 1, 10);
  const timeoutMs = envNumber("PROD_PERF_TIMEOUT_MS", 120_000, 10_000, 300_000);
  const variant = label("PROD_PERF_VARIANT", "control");
  const deployment = process.env.PROD_PERF_DEPLOYMENT
    ? label("PROD_PERF_DEPLOYMENT", "")
    : null;
  const output = resolve(
    process.env.PROD_PERF_OUTPUT ?? "./.performance/production-latest.json"
  );
  activePhase = "browser_launch";
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: resolve(storageState),
    viewport: { height: 900, width: 1440 },
  });
  const samples: ProductionSample[] = [];
  const previousIds = new Set<string>();
  try {
    for (const slug of bots) {
      // biome-ignore lint/performance/noAwaitInLoops: Production samples are intentionally sequential to preserve bot/session isolation.
      const page = await context.newPage();
      const botStartCount = samples.length;
      try {
        activePhase = "stream_install";
        await installSseLatencyProbe(page, slug);
        const mainThread = await installMainThreadDiagnostics(page);
        activePhase = "navigate";
        await page.goto(`${origin}/b/${slug}`, {
          timeout: timeoutMs,
          waitUntil: "domcontentloaded",
        });
        activePhase = "stream_ready";
        await waitForSseLatencyReadiness(page, slug, timeoutMs);
        activePhase = "composer_ready";
        await page
          .locator('textarea[placeholder="Write a message"]')
          .waitFor({ state: "visible", timeout: timeoutMs });
        activePhase = "bot_metadata";
        const metadataResponse = await jsonRequest(
          page,
          `/api/bots/${encodeURIComponent(slug)}`
        );
        const metadata = metadataFromBot(metadataResponse.body);
        for (let index = 0; index < samplesPerBot; index += 1) {
          activePhase = "sample";
          samples.push(
            // biome-ignore lint/performance/noAwaitInLoops: Repeated measurements share one browser session and must not overlap.
            await runSample(
              page,
              slug,
              metadata,
              index > 0,
              timeoutMs,
              deployment,
              previousIds,
              mainThread
            )
          );
        }
      } catch (error) {
        for (
          let index = samples.length - botStartCount;
          index < samplesPerBot;
          index += 1
        ) {
          samples.push({
            ackWallMs: null,
            bot: slug,
            cacheReadCount: null,
            cacheWriteCount: null,
            costUsd: null,
            deliveryConsumedMs: null,
            deliveryId: null,
            deliverySettledMs: null,
            deployment,
            eventScanTruncated: false,
            failureCode: "preflight_failed",
            failurePhase: activePhase,
            firstTokenVisibleMs: null,
            firstVisibleMs: null,
            inputCount: null,
            interactionCount: 0,
            messageId: null,
            missingStages: [],
            model: null,
            modelRunCount: 0,
            outcome: "failed",
            outputCount: null,
            provider: BOT_PROVIDERS[slug],
            qualityPassed: false,
            repeat: index > 0,
            sessionId: null,
            spanId: null,
            toolCallCount: 0,
            traceComplete: false,
            traceCorrelated: false,
            traceId: null,
            traceIsolated: false,
            traceObservationMs: null,
            turnDurationMs: null,
            turnId: null,
            ...EMPTY_MAIN_THREAD_FIELDS,
            ...EMPTY_SSE_FIELDS,
            usageCoverage: null,
            usageModelRuns: [],
          });
        }
        process.stderr.write(
          `${JSON.stringify({ bot: slug, errorCode: safeErrorCode(error) })}\n`
        );
      } finally {
        await page.close();
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }
  const report: ProductionReport = {
    deployment,
    generatedAt: new Date().toISOString(),
    harness: { origin, runtime: "chromium", samplesPerBot, timeoutMs, variant },
    samples,
    summary: buildProductionSummary(samples),
  };
  assertMetadataOnly(report);
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ output, summary: report.summary })}\n`
  );
}

async function main() {
  const output = resolve(
    process.env.PROD_PERF_OUTPUT ?? "./.performance/production-latest.json"
  );
  try {
    await runMain();
  } catch (error) {
    await writeFailureEnvelope(output, activePhase, error);
    process.exitCode = 1;
  }
}

await main();
