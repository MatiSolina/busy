// biome-ignore-all lint/performance/noAwaitInLoops: Repeated samples intentionally share one native SSE page.

import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { chromium } from "@playwright/test";
import {
  beginMainThreadSample,
  installMainThreadDiagnostics,
  readMainThreadDiagnostics,
  stopMainThreadSample,
} from "./production-main-thread";
import {
  classifySseClock,
  correlateSseToFullyVisible,
  installSseLatencyProbe,
  markSseRequestStart,
  readSseLatencyProbe,
  resolveExactReplyPart,
  stopSseLatencyProbe,
  waitForSseLatencyReadiness,
} from "./production-sse-probe";
import {
  beginVisibilityObservation,
  finishVisibilityObservation,
} from "./production-visibility";

const slug = "qa-1104-operaciones-tokenpass";
let streamResponse: ServerResponse | null = null;

function sendSse(
  channel: "fact" | "progress" | "session",
  payload: unknown
): void {
  streamResponse?.write(
    `event: ${channel}\ndata: ${JSON.stringify(payload)}\n\n`
  );
}

function sendFact(
  type: string,
  data: Record<string, unknown>,
  identity?: { index: number; line: number }
): void {
  sendSse("fact", { data, type, ...identity });
}

function sendProgress(data: Record<string, unknown>): void {
  sendSse("progress", { data, type: "content.delta" });
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const server = createServer((request, response) => {
  if (request.url?.startsWith(`/api/bots/${slug}/events`)) {
    const openStream = () => {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream",
      });
      streamResponse = response;
      sendSse("session", { sessionId: "fixture-session" });
      for (let index = 0; index < 20; index += 1) {
        sendFact(
          "turn.started",
          { turnId: `old-turn-${index}` },
          { index: 0, line: index }
        );
      }
      request.on("close", () => {
        if (streamResponse === response) {
          streamResponse = null;
        }
      });
    };
    if (request.url.includes("delayed=1")) {
      setTimeout(openStream, 50);
    } else {
      openStream();
    }
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(
    `<!doctype html><main data-chat-scroll style="width:400px">${Array.from(
      { length: 20 },
      (_, index) => `<div class="prose-chat">old-${index}</div>`
    ).join("")}</main>`
  );
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

try {
  await installSseLatencyProbe(page, slug, 16);
  const mainThread = await installMainThreadDiagnostics(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await markSseRequestStart(page, "BUSY_PROD_PERF_FIXTURE_PREOPEN");
  await page.evaluate((path) => {
    (window as Window & { __fixtureSource?: EventSource }).__fixtureSource =
      new EventSource(path);
  }, `/api/bots/${slug}/events?delayed=1`);
  await waitForSseLatencyReadiness(page, slug, 5000);
  const preopenSnapshot = await readSseLatencyProbe(page);
  ensure(
    preopenSnapshot.requestStartedAtMs !== null &&
      preopenSnapshot.openedAtMs !== null &&
      preopenSnapshot.sessionAtMs !== null &&
      preopenSnapshot.requestStartedAtMs < preopenSnapshot.openedAtMs &&
      preopenSnapshot.requestStartedAtMs < preopenSnapshot.sessionAtMs,
    "fixture must capture POST-before-SSE-open ordering"
  );
  ensure(
    classifySseClock(preopenSnapshot) === "valid",
    "POST-before-SSE-open is a valid same-document clock"
  );
  await page.waitForFunction(
    "() => window.__busyPerfSseProbe?.observedEventCount >= 20",
    undefined,
    { timeout: 5000 }
  );
  const replay = (await page.evaluate(
    "(() => ({ droppedEvents: window.__busyPerfSseProbe?.droppedEvents ?? 0 }))()"
  )) as { droppedEvents: number };
  assert(
    replay.droppedEvents > 0,
    "old replay should overflow the preflight ring"
  );

  await markSseRequestStart(page, "BUSY_PROD_PERF_AMBIGUOUS");
  sendFact(
    "turn.started",
    { turnId: "fixture-ambiguous-turn" },
    { index: 0, line: 100 }
  );
  sendFact(
    "content.completed",
    {
      kind: "text",
      partId: "fixture-ambiguous-reply-a",
      phase: "reply",
      value: "BUSY_PROD_PERF_AMBIGUOUS",
    },
    { index: 0, line: 101 }
  );
  sendFact(
    "content.completed",
    {
      kind: "text",
      partId: "fixture-ambiguous-reply-b",
      phase: "reply",
      value: "BUSY_PROD_PERF_AMBIGUOUS",
    },
    { index: 0, line: 102 }
  );
  await page.waitForFunction(
    "() => (window.__busyPerfSseProbe?.matchedReplyCount ?? 0) >= 2",
    undefined,
    { timeout: 5000 }
  );
  const ambiguousResolution = await resolveExactReplyPart(page);
  ensure(
    !ambiguousResolution.exactReplyMatch &&
      ambiguousResolution.targetPartId === null,
    "distinct matching replies must remain ambiguous"
  );
  await stopSseLatencyProbe(page);

  const samples: Record<string, unknown>[] = [];
  for (let index = 0; index < 2; index += 1) {
    const marker = `BUSY_PROD_PERF_FIXTURE_FINAL_${index}`;
    const turnId = `fixture-turn-${index}`;
    const reasoningPartId = `fixture-reasoning-${index}`;
    const replyPartId = `fixture-reply-${index}`;
    await beginVisibilityObservation(page, marker);
    await beginMainThreadSample(mainThread);
    const resetDiagnostics = await readMainThreadDiagnostics(mainThread);
    ensure(resetDiagnostics.supported, "CDP task duration must be supported");
    ensure(
      resetDiagnostics.taskDurationDeltaMs !== null &&
        resetDiagnostics.taskDurationDeltaMs < 5,
      "main-thread counters must reset per sample"
    );
    await markSseRequestStart(page, marker);
    sendFact("turn.started", { turnId }, { index: 0, line: 200 + index * 10 });
    sendFact(
      "content.completed",
      {
        kind: "reasoning",
        partId: reasoningPartId,
        phase: "reasoning",
        value: "internal reasoning is not the public reply",
      },
      { index: 0, line: 201 + index * 10 }
    );
    sendProgress({ delta: "partial", kind: "text", partId: replyPartId });
    await page.evaluate(() => {
      const element = document.createElement("div");
      element.className = "prose-chat";
      element.textContent = "BUSY_PROD_PERF_FIXTURE_PARTIAL";
      document.querySelector("[data-chat-scroll]")?.append(element);
    });
    await page.waitForTimeout(75);
    await page.evaluate(() => {
      const end = performance.now() + 200;
      while (performance.now() < end) {
        // Deliberately block the fixture main thread to prove the diagnostic.
      }
    });
    const partialState = (await page.evaluate(
      "(() => { const state = window.__busyPerfVisibility?.state; return { firstToken: state?.firstTokenVisibleMs ?? null, firstVisible: state?.firstVisibleMs ?? null }; })()"
    )) as { firstToken: number | null; firstVisible: number | null };
    const partialBeforeAck = partialState.firstToken !== null;
    ensure(
      partialState.firstVisible === null,
      "partial text must not count as the full marker being visible"
    );
    sendFact(
      "content.completed",
      {
        kind: "text",
        partId: replyPartId,
        phase: "reply",
        value: marker,
      },
      { index: 0, line: 203 + index * 10 }
    );
    sendFact(
      "content.completed",
      {
        kind: "text",
        partId: replyPartId,
        phase: "reply",
        value: marker,
      },
      { index: 0, line: 203 + index * 10 }
    );
    await page.waitForFunction(
      "() => window.__busyPerfSseProbe?.exactReplyMatch === true",
      undefined,
      { timeout: 5000 }
    );
    await page.evaluate((value) => {
      const element =
        document.querySelector("[data-chat-scroll]")?.lastElementChild;
      if (element) {
        element.textContent = value;
      }
    }, marker);
    const visibility = await finishVisibilityObservation(page);
    const resolution = await resolveExactReplyPart(page);
    const snapshot = await stopSseLatencyProbe(page);
    const mainThreadSample = await stopMainThreadSample(mainThread);
    const sseClockStatus = classifySseClock(snapshot);
    const fullyVisible = correlateSseToFullyVisible(
      snapshot,
      { partId: resolution.targetPartId, turnId },
      visibility.firstVisibleAtMs
    );
    ensure(
      visibility.firstTokenVisibleAtMs !== null &&
        visibility.firstVisibleAtMs !== null &&
        visibility.firstTokenVisibleMs !== null &&
        visibility.firstVisibleMs !== null &&
        visibility.firstTokenVisibleAtMs < visibility.firstVisibleAtMs &&
        visibility.firstTokenVisibleMs < visibility.firstVisibleMs,
      "first token must be visible strictly before the full marker"
    );
    ensure(
      partialBeforeAck,
      "partial assistant text must be visible before ACK"
    );
    ensure(snapshot.droppedEvents === 0, "sample ring must reset after replay");
    ensure(snapshot.exactReplyMatch, "completed reply must match exactly");
    ensure(sseClockStatus === "valid", "fixture SSE clock must be valid");
    const probeShape = (await page.evaluate(
      "(() => { const state = window.__busyPerfSseProbe; return { hasCompletedParts: Object.prototype.hasOwnProperty.call(state, 'completedParts'), hasRawEventFields: state.events.some((event) => Object.keys(event).some((key) => ['text', 'value', 'delta'].includes(key))) }; })()"
    )) as { hasCompletedParts: boolean; hasRawEventFields: boolean };
    ensure(
      !(probeShape.hasCompletedParts || probeShape.hasRawEventFields),
      "probe must not retain completed text"
    );
    ensure(
      mainThreadSample.supported,
      "CDP task duration must remain supported"
    );
    ensure(
      mainThreadSample.taskDurationDeltaMs !== null &&
        mainThreadSample.taskDurationDeltaMs > 0,
      "fixture main-thread task duration must be observed"
    );
    ensure(resolution.exactReplyMatch, "reply part must match exactly");
    ensure(
      resolution.targetPartId === replyPartId,
      "reply part must be selected"
    );
    ensure(
      resolution.targetPartId !== reasoningPartId,
      "reasoning part must be rejected"
    );
    ensure(
      visibility.qualityPassed,
      "final assistant marker must match exactly"
    );
    ensure(
      fullyVisible.turnFullyVisibleStatus === "measured",
      "turn fully-visible interval must be measured"
    );
    ensure(
      fullyVisible.textPartFullyVisibleStatus === "measured",
      "text fully-visible interval must be measured"
    );
    samples.push({
      exactReplyMatch: resolution.exactReplyMatch,
      firstRelatedTextPartEventType: fullyVisible.firstRelatedTextPartEventType,
      firstRelatedTurnEventType: fullyVisible.firstRelatedTurnEventType,
      firstTokenVisibleMs: visibility.firstTokenVisibleMs,
      firstVisibleMs: visibility.firstVisibleMs,
      mainThreadTaskDurationDeltaMs: mainThreadSample.taskDurationDeltaMs,
      partialBeforeAck,
      sample: index,
      sseClockStatus,
      sseDroppedEventCount: snapshot.droppedEvents,
      sseObservedEventCount: snapshot.observedEventCount,
      sseTextPartToFullyVisibleMs: fullyVisible.textPartToFullyVisibleMs,
      sseTurnToFullyVisibleMs: fullyVisible.turnToFullyVisibleMs,
      targetPartId: resolution.targetPartId,
    });
  }
  process.stdout.write(
    `${JSON.stringify({
      distinctReplyAmbiguityPreserved: true,
      eventSource: "native_open_and_session_received",
      exactFinalQuality: true,
      oldReplayOverflowedBeforeSample: true,
      reasoningPartRejected: samples.every(
        (sample) =>
          sample.targetPartId !== "fixture-reasoning-0" &&
          sample.targetPartId !== "fixture-reasoning-1"
      ),
      repeatedSamplesResetRing: samples.every(
        (sample) => sample.sseDroppedEventCount === 0
      ),
      samples,
    })}\n`
  );
} finally {
  await page.close();
  await browser.close();
  server.close();
}
