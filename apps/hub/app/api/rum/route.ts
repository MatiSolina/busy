import { metric } from "@vercel/functions";
import { logChatObservation } from "@/lib/chat/observability";
import { RUM_METRICS, type RumMetric } from "@/lib/rum/client";

const MAX_BODY_BYTES = 4096;
const MAX_SAMPLES = 20;
// Ten minutes: anything longer is a stuck clock (sleep, hidden tab), not a turn.
const MAX_VALUE_MS = 600_000;
const LOG_FIELD: Record<RumMetric, string> = {
  "chat.send_ack": "sendAckMs",
  "chat.ttft": "ttftMs",
};
const known = new Set<string>(RUM_METRICS);

/** Browser timings behind the session gate (proxy.ts). Accepts only allowlisted numeric samples. */
export async function POST(req: Request) {
  if (process.env.NEXT_PUBLIC_RUM !== "1") {
    return new Response(null, { status: 204 });
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let samples: unknown;
  try {
    ({ samples } = JSON.parse(text) as { samples?: unknown });
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!Array.isArray(samples)) {
    return new Response(null, { status: 400 });
  }
  for (const sample of samples.slice(0, MAX_SAMPLES)) {
    const { name, value } = (sample ?? {}) as {
      name?: unknown;
      value?: unknown;
    };
    if (
      typeof name !== "string" ||
      !known.has(name) ||
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_VALUE_MS
    ) {
      continue;
    }
    metric(`${name}_ms`, value);
    logChatObservation("chat.rum", {
      [LOG_FIELD[name as RumMetric]]: Math.round(value),
    });
  }
  return new Response(null, { status: 204 });
}
