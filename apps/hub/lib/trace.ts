import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";

const tracer = trace.getTracer("busy-hub");
const NOT_TOKEN = /[^\w-]/gu;
const SEPARATOR = /[^A-Za-z0-9]/u;

/** Wall time per stage of one request, in ms, keyed by span name. */
export type Stages = Record<string, number>;

/**
 * Runs `fn` inside an OpenTelemetry span. With `stages`, also adds its duration under `name`, for
 * the response's Server-Timing header and the request's `busy.chat` log line.
 * Errors only mark the span failed: exception messages can carry provider bodies or credentials.
 */
export function span<T>(
  name: string,
  fn: () => Promise<T>,
  stages?: Stages,
  attributes?: Attributes
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (s) => {
    const startedAt = performance.now();
    try {
      return await fn();
    } catch (error) {
      s.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      if (stages) {
        stages[name] =
          (stages[name] ?? 0) + Math.round(performance.now() - startedAt);
      }
      s.end();
    }
  });
}

/** `eve.send` → `eve_send;dur=12`. Names are code constants, never user data. */
export function serverTiming(stages: Stages): string {
  return Object.entries(stages)
    .map(([name, ms]) => `${name.replaceAll(NOT_TOKEN, "_")};dur=${ms}`)
    .join(", ");
}

/** `eve.send` → `stageEveSendMs`, the allowlisted shape for `busy.chat` log fields. */
export function stageFields(stages: Stages): Record<string, number> {
  return Object.fromEntries(
    Object.entries(stages).map(([name, ms]) => [
      `stage${name
        .split(SEPARATOR)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")}Ms`,
      ms,
    ])
  );
}
