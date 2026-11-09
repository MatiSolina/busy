import type { Page } from "@playwright/test";

export interface SseProbeEvent {
  channel: "fact" | "progress";
  eventType: string | null;
  partId: string | null;
  receivedAtMs: number;
  runId: string | null;
  turnId: string | null;
}

export interface SseProbeSnapshot {
  droppedEvents: number;
  events: SseProbeEvent[];
  exactReplyMatch: boolean;
  matchedReplyCount: number;
  observedEventCount: number;
  openedAtMs: number | null;
  requestStartedAtMs: number | null;
  sessionAtMs: number | null;
  sessionId: string | null;
  targetPartId: string | null;
  targetTurnId: string | null;
  timeOriginMs: number | null;
}

export interface ReplyPartResolution {
  exactReplyMatch: boolean;
  targetPartId: string | null;
  targetTurnId: string | null;
}

export type FullyVisibleIntervalStatus =
  | "invalid_clock"
  | "measured"
  | "missing_event"
  | "missing_fully_visible"
  | "ring_overflow";

export type SseClockStatus = "valid" | "missing" | "inconsistent";

export interface SseFullyVisibleCorrelation {
  firstRelatedTextPartEventAtMs: number | null;
  firstRelatedTextPartEventType: string | null;
  firstRelatedTurnEventAtMs: number | null;
  firstRelatedTurnEventType: string | null;
  firstVisibleAtMs: number | null;
  textPartFullyVisibleStatus: FullyVisibleIntervalStatus;
  textPartToFullyVisibleMs: number | null;
  turnFullyVisibleStatus: FullyVisibleIntervalStatus;
  turnToFullyVisibleMs: number | null;
}

const EMPTY_SNAPSHOT: SseProbeSnapshot = {
  droppedEvents: 0,
  events: [],
  exactReplyMatch: false,
  matchedReplyCount: 0,
  observedEventCount: 0,
  openedAtMs: null,
  requestStartedAtMs: null,
  sessionAtMs: null,
  sessionId: null,
  targetPartId: null,
  targetTurnId: null,
  timeOriginMs: null,
};

const DEFAULT_RING_SIZE = 96;

/**
 * Installs a native EventSource observer before navigation. It stores only
 * bounded timing and correlation metadata. Completed public-part text is
 * compared immediately in the browser callback and never stored or sent to
 * the Node process.
 */
export async function installSseLatencyProbe(
  page: Page,
  slug: string,
  ringSize = DEFAULT_RING_SIZE
): Promise<void> {
  const boundedRingSize = Math.min(256, Math.max(16, Math.floor(ringSize)));
  await page.addInitScript({
    content: `(() => {
      const targetPath = ${JSON.stringify(`/api/bots/${slug}/events`)};
      const maxEvents = ${boundedRingSize};
      const NativeEventSource = window.EventSource;
      const state = {
        active: true,
        activeTurnId: null,
        droppedEvents: 0,
        events: [],
        exactReplyMatch: false,
        expectedMarker: null,
        matchedReplyCount: 0,
        observedEventCount: 0,
        openedAtMs: null,
        path: targetPath,
        requestStartedAtMs: null,
        sessionAtMs: null,
        sessionId: null,
        targetPartId: null,
        targetTurnId: null,
        timeOriginMs: typeof performance.timeOrigin === "number" && Number.isFinite(performance.timeOrigin) ? performance.timeOrigin : null,
        seenFactKeys: new Set(),
      };
      const record = (value) => value && typeof value === "object" ? value : null;
      const safe = (value) => {
        if (typeof value !== "string" || value.length < 1 || value.length > 128) return null;
        return /^[A-Za-z0-9._:-]+$/.test(value) ? value : null;
      };
      const safeNumber = (value) => {
        if (!Number.isInteger(value) || value < 0 || value > 1000000000) return null;
        return value;
      };
      const append = (channel, event) => {
        if (!state.active) return;
        const receivedAtMs = performance.now();
        let parsed = null;
        if (typeof event.data === "string") {
          try { parsed = JSON.parse(event.data); } catch { parsed = null; }
        }
        const root = record(parsed);
        const firstData = record(root?.data) || root;
        const payload = record(firstData?.data) || firstData;
        const scope = record(root?.scope) || record(firstData?.scope) || record(payload?.scope);
        const eventType = safe(root?.type) || safe(firstData?.type) || safe(payload?.type);
        const partId = safe(payload?.partId) || safe(firstData?.partId) || safe(root?.partId) || safe(scope?.partId);
        const runId = safe(payload?.runId) || safe(firstData?.runId) || safe(root?.runId) || safe(scope?.runId);
        const factIdentity =
          channel === "fact" && safeNumber(root?.line) !== null && safeNumber(root?.index) !== null
            ? "line:" + safeNumber(root?.line) + ":index:" + safeNumber(root?.index)
            : channel === "fact" && safe(event.lastEventId)
              ? "event:" + safe(event.lastEventId)
              : eventType === "content.completed" && partId
                ? "completed:" + partId + ":" + (runId || "")
                : null;
        const dedupeKey = factIdentity
          ? (state.sessionId || "unknown-session") + ":" + factIdentity
          : null;
        if (dedupeKey && state.seenFactKeys.has(dedupeKey)) return;
        if (dedupeKey) {
          state.seenFactKeys.add(dedupeKey);
          if (state.seenFactKeys.size > maxEvents) {
            state.seenFactKeys.delete(state.seenFactKeys.values().next().value);
          }
        }
        const explicitTurnId = safe(payload?.turnId) || safe(firstData?.turnId) || safe(root?.turnId) || safe(scope?.turnId);
        if (explicitTurnId) state.activeTurnId = explicitTurnId;
        const turnId = explicitTurnId || state.activeTurnId;
        const isExactPublicReply =
          eventType === "content.completed" &&
          partId &&
          state.expectedMarker !== null &&
          payload?.kind === "text" &&
          payload?.phase === "reply" &&
          typeof payload?.value === "string" &&
          payload.value === state.expectedMarker;
        if (isExactPublicReply) {
          state.matchedReplyCount += 1;
          state.exactReplyMatch = state.matchedReplyCount === 1;
          state.targetPartId = state.exactReplyMatch ? partId : null;
          state.targetTurnId = state.exactReplyMatch ? turnId : null;
        }
        state.observedEventCount += 1;
        state.events.push({ channel, eventType, partId, receivedAtMs, runId, turnId });
        if (state.events.length > maxEvents) {
          state.events.shift();
          state.droppedEvents += 1;
        }
        if (eventType === "turn.settled") state.activeTurnId = null;
        // Parsed payloads and any completed value are released after this
        // callback. Only the exact-match metadata survives.
      };
      class ObservedEventSource extends NativeEventSource {
        constructor(url, eventSourceInitDict) {
          super(url, eventSourceInitDict);
          const path = new URL(url, window.location.href).pathname;
          if (path !== targetPath) return;
          this.addEventListener("open", () => {
            if (state.openedAtMs === null) state.openedAtMs = performance.now();
          });
          this.addEventListener("session", (event) => {
            if (state.sessionAtMs === null) state.sessionAtMs = performance.now();
            if (typeof event.data === "string") {
              try {
                const sessionPayload = JSON.parse(event.data);
                const sessionRecord = record(sessionPayload);
                state.sessionId = safe(
                  sessionRecord?.sessionId || sessionRecord?.data?.sessionId
                );
              } catch {}
            }
          });
          this.addEventListener("fact", (event) => append("fact", event));
          this.addEventListener("progress", (event) => append("progress", event));
        }
      }
      Object.defineProperties(ObservedEventSource, {
        CLOSED: { value: NativeEventSource.CLOSED },
        CONNECTING: { value: NativeEventSource.CONNECTING },
        OPEN: { value: NativeEventSource.OPEN },
      });
      Object.defineProperty(window, "EventSource", {
        configurable: true,
        value: ObservedEventSource,
      });
      window.__busyPerfSseProbe = state;
    })();`,
  });
}

export async function waitForSseLatencyReadiness(
  page: Page,
  slug: string,
  timeoutMs: number
): Promise<void> {
  await page.waitForFunction(
    `(() => {
      const state = window.__busyPerfSseProbe;
      return state?.active === true &&
        state.path === ${JSON.stringify(`/api/bots/${slug}/events`)} &&
        typeof state.openedAtMs === "number" &&
        typeof state.sessionAtMs === "number";
    })()`,
    undefined,
    { polling: "raf", timeout: timeoutMs }
  );
}

export async function markSseRequestStart(
  page: Page,
  expectedMarker: string
): Promise<void> {
  await page.evaluate(`(() => {
    const state = window.__busyPerfSseProbe;
    if (!state) return;
    state.active = true;
    state.activeTurnId = null;
    state.droppedEvents = 0;
    state.events.length = 0;
    state.exactReplyMatch = false;
    state.expectedMarker = ${JSON.stringify(expectedMarker)};
    state.matchedReplyCount = 0;
    state.observedEventCount = 0;
    state.requestStartedAtMs = performance.now();
    state.seenFactKeys.clear();
    state.targetPartId = null;
    state.targetTurnId = null;
  })()`);
}

export async function resolveExactReplyPart(
  page: Page
): Promise<ReplyPartResolution> {
  return await page.evaluate(`(() => {
    const state = window.__busyPerfSseProbe;
    if (!state) return { exactReplyMatch: false, targetPartId: null, targetTurnId: null };
    const result = {
      exactReplyMatch: state.exactReplyMatch,
      targetPartId: state.targetPartId,
      targetTurnId: state.targetTurnId,
    };
    state.expectedMarker = null;
    state.matchedReplyCount = 0;
    return result;
  })()`);
}

export async function readSseLatencyProbe(
  page: Page
): Promise<SseProbeSnapshot> {
  return await page.evaluate(`(() => {
    const state = window.__busyPerfSseProbe;
    if (!state) return ${JSON.stringify(EMPTY_SNAPSHOT)};
    return {
      droppedEvents: state.droppedEvents,
      events: state.events.map((event) => ({
        channel: event.channel,
        eventType: event.eventType,
        partId: event.partId,
        receivedAtMs: event.receivedAtMs,
        runId: event.runId,
        turnId: event.turnId,
      })),
      exactReplyMatch: state.exactReplyMatch,
      matchedReplyCount: state.matchedReplyCount,
      observedEventCount: state.observedEventCount,
      openedAtMs: state.openedAtMs,
      requestStartedAtMs: state.requestStartedAtMs,
      sessionAtMs: state.sessionAtMs,
      sessionId: state.sessionId,
      targetPartId: state.targetPartId,
      targetTurnId: state.targetTurnId,
      timeOriginMs: state.timeOriginMs,
    };
  })()`);
}

export async function stopSseLatencyProbe(
  page: Page
): Promise<SseProbeSnapshot> {
  return await page.evaluate(`(() => {
    const state = window.__busyPerfSseProbe;
    if (!state) return ${JSON.stringify(EMPTY_SNAPSHOT)};
    state.active = false;
    const snapshot = {
      droppedEvents: state.droppedEvents,
      events: state.events.map((event) => ({
        channel: event.channel,
        eventType: event.eventType,
        partId: event.partId,
        receivedAtMs: event.receivedAtMs,
        runId: event.runId,
        turnId: event.turnId,
      })),
      exactReplyMatch: state.exactReplyMatch,
      matchedReplyCount: state.matchedReplyCount,
      observedEventCount: state.observedEventCount,
      openedAtMs: state.openedAtMs,
      requestStartedAtMs: state.requestStartedAtMs,
      sessionAtMs: state.sessionAtMs,
      sessionId: state.sessionId,
      targetPartId: state.targetPartId,
      targetTurnId: state.targetTurnId,
      timeOriginMs: state.timeOriginMs,
    };
    state.events.length = 0;
    state.expectedMarker = null;
    state.matchedReplyCount = 0;
    state.seenFactKeys.clear();
    return snapshot;
  })()`);
}

export function classifySseClock(snapshot: SseProbeSnapshot): SseClockStatus {
  const values = [
    snapshot.timeOriginMs,
    snapshot.openedAtMs,
    snapshot.sessionAtMs,
    snapshot.requestStartedAtMs,
  ];
  if (
    values.some(
      (value) => value !== null && (!Number.isFinite(value) || value < 0)
    )
  ) {
    return "inconsistent";
  }
  if (values.some((value) => value === null)) {
    return "missing";
  }
  return "valid";
}

/**
 * Correlates separate turn-level and exact public-text-part events with the
 * visibility timestamp from the same browser performance clock. It never
 * treats a missing or negative interval as a zero.
 */
export function correlateSseToFullyVisible(
  snapshot: SseProbeSnapshot,
  target: { partId: string | null; turnId: string | null },
  firstVisibleAtMs: number | null
): SseFullyVisibleCorrelation {
  const turnEvent = target.turnId
    ? snapshot.events.find((event) => event.turnId === target.turnId)
    : undefined;
  const textPartEvent = target.partId
    ? snapshot.events.find((event) => event.partId === target.partId)
    : undefined;
  const interval = (
    event: SseProbeEvent | undefined
  ): { durationMs: number | null; status: FullyVisibleIntervalStatus } => {
    if (snapshot.droppedEvents > 0) {
      return { durationMs: null, status: "ring_overflow" };
    }
    if (!event) {
      return { durationMs: null, status: "missing_event" };
    }
    if (firstVisibleAtMs === null) {
      return { durationMs: null, status: "missing_fully_visible" };
    }
    const durationMs = firstVisibleAtMs - event.receivedAtMs;
    return durationMs >= 0 && Number.isFinite(durationMs)
      ? { durationMs, status: "measured" }
      : { durationMs: null, status: "invalid_clock" };
  };
  const turnInterval = interval(turnEvent);
  const textPartInterval = interval(textPartEvent);
  return {
    firstRelatedTextPartEventAtMs: textPartEvent?.receivedAtMs ?? null,
    firstRelatedTextPartEventType: textPartEvent?.eventType ?? null,
    firstRelatedTurnEventAtMs: turnEvent?.receivedAtMs ?? null,
    firstRelatedTurnEventType: turnEvent?.eventType ?? null,
    firstVisibleAtMs,
    textPartFullyVisibleStatus: textPartInterval.status,
    textPartToFullyVisibleMs: textPartInterval.durationMs,
    turnFullyVisibleStatus: turnInterval.status,
    turnToFullyVisibleMs: turnInterval.durationMs,
  };
}
