import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import type { ProductionSourceSample } from "./production-config";
import {
  classifyEnrichmentSourceSample,
  type EnrichmentSourceSample,
  preservePreflightFailure,
} from "./production-enrichment";
import {
  assertMetadataOnly,
  safeErrorCode,
  traceCompleteFromMetadata,
  usageMetadataFromTrace,
} from "./production-metrics";

const origin = "https://app.busybot.dev";
const safeIdPattern = /^[A-Za-z0-9._:-]{1,128}$/u;

interface SourceReport {
  samples: unknown[];
}

function safeId(value: unknown): string | null {
  return typeof value === "string" && safeIdPattern.test(value) ? value : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function traceMetadata(body: unknown) {
  const trace =
    body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const correlation = (trace.correlation ?? {}) as Record<string, unknown>;
  const eventWindow = (trace.eventWindow ?? {}) as Record<string, unknown>;
  const stages = (trace.stages ?? {}) as Record<string, unknown>;
  const delivery = (stages.delivery ?? {}) as Record<string, unknown>;
  const turn = (stages.turn ?? {}) as Record<string, unknown>;
  const tools = Array.isArray(stages.tools) ? stages.tools : [];
  const modelAttempts = Array.isArray(stages.modelAttempts)
    ? stages.modelAttempts
    : [];
  const usage = usageMetadataFromTrace(trace);
  return {
    cacheReadCount: usage.totals.cacheReadCount,
    cacheWriteCount: usage.totals.cacheWriteCount,
    costUsd: usage.totals.costUsd,
    deliveryConsumedMs: numeric(delivery.consumedDurationMs),
    deliveryId: safeId(correlation.deliveryId),
    deliverySettledMs: numeric(delivery.settledDurationMs),
    eventScanTruncated: eventWindow.scanTruncated === true,
    inputCount: usage.totals.inputCount,
    messageId: safeId((trace.message as { id?: unknown } | undefined)?.id),
    missingStages: Array.isArray(trace.missing)
      ? trace.missing.filter((item): item is string => typeof item === "string")
      : [],
    modelRunCount: modelAttempts.length,
    outputCount: usage.totals.outputCount,
    sessionId: safeId(correlation.sessionId),
    spanId: safeId(correlation.spanId),
    toolCallCount: tools.length,
    traceComplete: traceCompleteFromMetadata(trace),
    traceId: safeId(correlation.traceId),
    turnDurationMs: numeric(turn.durationMs),
    turnId: safeId(correlation.turnId),
    usageCoverage: usage.coverage,
    usageModelRuns: usage.modelRuns,
  };
}

async function getTrace(
  page: import("@playwright/test").Page,
  bot: string,
  messageId: string
) {
  return await page.evaluate(
    async ({ bot: targetBot, messageId: targetMessageId }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(
          `/api/bots/${encodeURIComponent(targetBot)}/messages/${encodeURIComponent(targetMessageId)}/trace`,
          { cache: "no-store", signal: controller.signal }
        );
        return {
          body: await response.json().catch(() => null),
          status: response.status,
        };
      } catch (error) {
        return { body: null, status: error instanceof DOMException ? 0 : 599 };
      } finally {
        clearTimeout(timer);
      }
    },
    { bot, messageId }
  );
}

const sourcePath = process.env.PROD_ENRICH_SOURCE;
const storageState = process.env.PROD_PERF_STORAGE_STATE;
assert(
  sourcePath && storageState,
  "PROD_ENRICH_SOURCE and PROD_PERF_STORAGE_STATE are required"
);
const output = resolve(
  process.env.PROD_ENRICH_OUTPUT ??
    "./.performance/production-trace-enrichment.json"
);
const deployment = process.env.PROD_PERF_DEPLOYMENT ?? null;
const correction = "usage_schema_v2_incomplete_flag_unique_model_attempt_join";
await access(resolve(sourcePath));
await access(resolve(storageState));
const source = JSON.parse(await readFile(sourcePath, "utf8")) as SourceReport;
assert(
  source && typeof source === "object" && Array.isArray(source.samples),
  "source_schema_invalid"
);
const sourceSamples: EnrichmentSourceSample[] = source.samples.map((sample) => {
  const classified = classifyEnrichmentSourceSample(sample);
  assert(classified, "source_schema_invalid");
  return classified;
});
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: resolve(storageState),
});
const samples: Record<string, unknown>[] = [];
try {
  const page = await context.newPage();
  for (const classified of sourceSamples) {
    if (classified.kind === "preflight_failure") {
      samples.push(preservePreflightFailure(classified.sample));
      continue;
    }
    const sample: ProductionSourceSample = classified.sample;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Trace enrichment is sequential and bounded.
      await page.goto(`${origin}/b/${encodeURIComponent(sample.bot)}`, {
        timeout: 30_000,
        waitUntil: "domcontentloaded",
      });
      const response = await getTrace(page, sample.bot, sample.messageId);
      if (response.status !== 200 || !response.body) {
        samples.push({
          bot: sample.bot,
          failureCode:
            response.status === 0 ? "timeout" : `http_${response.status}`,
          failurePhase: "trace_fetch",
          messageId: sample.messageId,
          outcome: "failed",
        });
        continue;
      }
      samples.push({
        bot: sample.bot,
        ...traceMetadata(response.body),
        outcome: "observed",
      });
    } catch (error) {
      samples.push({
        bot: sample.bot,
        failureCode: safeErrorCode(error),
        failurePhase: "trace_fetch",
        messageId: sample.messageId,
        outcome: "failed",
      });
    }
  }
} finally {
  await context.close();
  await browser.close();
}
const report = {
  correction,
  deployment,
  generatedAt: new Date().toISOString(),
  samples,
  summary: {
    completed: samples.filter((sample) => sample.traceComplete === true).length,
    failed: samples.filter((sample) => sample.outcome === "failed").length,
    samples: samples.length,
    timedOut: samples.filter((sample) => sample.failureCode === "timeout")
      .length,
    traceComplete: samples.filter((sample) => sample.traceComplete === true)
      .length,
  },
};
assertMetadataOnly(report);
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({ output, summary: report.summary })}\n`
);
