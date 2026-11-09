/** Chat timings measured in the browser. Numbers only: no text, ids or slugs leave the page. */
export const RUM_METRICS = ["chat.send_ack", "chat.ttft"] as const;
export type RumMetric = (typeof RUM_METRICS)[number];
export interface RumSample {
  name: RumMetric;
  value: number;
}

export interface ChatRum {
  /** The send POST answered; `ok` when the hub accepted the message. */
  ack: (slug: string, ok: boolean) => void;
  /** A text delta for this bot was just committed to the store. */
  firstText: (slug: string) => void;
  /** The user sent a message (click or Enter in the composer). */
  send: (slug: string) => void;
}

interface RumDeps {
  frame: (callback: () => void) => void;
  now: () => number;
  report: (sample: RumSample) => void;
}

/**
 * TTFT runs from the send to the first paint after the bot's first text delta,
 * like `firstTokenVisibleMs` in the production harness, simplified to one frame.
 * A second send before any text keeps the first one's clock.
 */
export function createChatRum(deps: RumDeps = browserDeps()): ChatRum {
  const sentAt = new Map<string, number>();
  return {
    ack(slug, ok) {
      const started = sentAt.get(slug);
      if (started === undefined) {
        return;
      }
      if (!ok) {
        sentAt.delete(slug);
        return;
      }
      deps.report({ name: "chat.send_ack", value: deps.now() - started });
    },
    firstText(slug) {
      const started = sentAt.get(slug);
      if (started === undefined) {
        return;
      }
      sentAt.delete(slug);
      deps.frame(() =>
        deps.report({ name: "chat.ttft", value: deps.now() - started })
      );
    },
    send(slug) {
      if (!sentAt.has(slug)) {
        sentAt.set(slug, deps.now());
      }
    },
  };
}

const RUM_ENDPOINT = "/api/rum";
const MAX_BATCH = 20;

function sendBeaconBody(body: string): void {
  navigator.sendBeacon(
    RUM_ENDPOINT,
    new Blob([body], { type: "application/json" })
  );
}

// Kept out of a default parameter: SWC rejects `in` there.
function whenIdle(callback: () => void): void {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(callback, { timeout: 5000 });
  } else {
    setTimeout(callback, 1000);
  }
}

/** Batches samples and sends them with sendBeacon when the main thread is idle or the page hides. */
export function beaconReporter(
  send: (body: string) => void = sendBeaconBody,
  idle: (callback: () => void) => void = whenIdle
): (sample: RumSample) => void {
  let queue: RumSample[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (queue.length === 0) {
      return;
    }
    const samples = queue.slice(0, MAX_BATCH);
    queue = queue.slice(MAX_BATCH);
    send(JSON.stringify({ samples }));
    if (queue.length > 0) {
      schedule();
    }
  };
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      idle(flush);
    }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        flush();
      }
    });
  }
  return (sample) => {
    queue.push({ name: sample.name, value: Math.round(sample.value) });
    schedule();
  };
}

function browserDeps(): RumDeps {
  return {
    frame: (callback) => requestAnimationFrame(() => callback()),
    now: () => performance.now(),
    report: beaconReporter(),
  };
}

export const rumEnabled = () => process.env.NEXT_PUBLIC_RUM === "1";
