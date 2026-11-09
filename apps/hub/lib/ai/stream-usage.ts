/** Numbers from a Responses API stream's final `usage`. Never text. */
export interface StreamUsage {
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** The tier the provider actually served (`priority` when Fast took effect). */
  serviceTier?: string;
}

export interface StreamTiming {
  /** From stream start to its first chunk. */
  firstChunkMs?: number;
  /** From stream start to its end, or to cancellation. */
  streamMs: number;
  usage: StreamUsage;
}

const COMPLETED = /"type"\s*:\s*"response\.(?:completed|incomplete)"/u;

const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

function usageOf(data: string): StreamUsage | undefined {
  try {
    const { response } = JSON.parse(data) as {
      response?: {
        service_tier?: unknown;
        usage?: {
          input_tokens?: unknown;
          input_tokens_details?: { cached_tokens?: unknown };
          output_tokens?: unknown;
          output_tokens_details?: { reasoning_tokens?: unknown };
        };
      };
    };
    const usage = response?.usage;
    if (!usage) {
      return;
    }
    return {
      cachedTokens: count(usage.input_tokens_details?.cached_tokens),
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      reasoningTokens: count(usage.output_tokens_details?.reasoning_tokens),
      serviceTier:
        typeof response.service_tier === "string"
          ? response.service_tier.slice(0, 32)
          : undefined,
    };
  } catch {
    return undefined; // A malformed final event leaves usage unknown; the stream is untouched.
  }
}

/**
 * Passes an SSE body through untouched and reports when its first chunk arrived and the final
 * usage numbers. Only `response.completed`/`incomplete` lines are parsed.
 */
export function observeStream(
  body: ReadableStream<Uint8Array>,
  done: (timing: StreamTiming) => void
): ReadableStream<Uint8Array> {
  const startedAt = performance.now();
  const decoder = new TextDecoder();
  let firstChunkMs: number | undefined;
  let pending = "";
  let usage: StreamUsage = {};
  let reported = false;
  const report = () => {
    if (!reported) {
      reported = true;
      done({
        firstChunkMs,
        streamMs: Math.round(performance.now() - startedAt),
        usage,
      });
    }
  };
  const scan = (text: string) => {
    const lines = (pending + text).split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:") && COMPLETED.test(line)) {
        usage = usageOf(line.slice(5).trim()) ?? usage;
      }
    }
  };
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      report();
      await reader.cancel(reason);
    },
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          scan(`${decoder.decode()}\n`);
          report();
          controller.close();
          return;
        }
        firstChunkMs ??= Math.round(performance.now() - startedAt);
        scan(decoder.decode(chunk.value, { stream: true }));
        controller.enqueue(chunk.value);
      } catch (error) {
        report();
        controller.error(error);
      }
    },
  });
}
