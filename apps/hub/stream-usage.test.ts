import { describe, expect, it } from "vitest";
import { observeStream, type StreamTiming } from "@/lib/ai/stream-usage";

const encode = (text: string) => new TextEncoder().encode(text);

function streamOf(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encode(chunk));
      }
      controller.close();
    },
  });
}

describe("observeStream", () => {
  it("passes bytes through and reads usage split across chunks", async () => {
    const completed = `data: ${JSON.stringify({
      response: {
        service_tier: "priority",
        usage: {
          input_tokens: 28_762,
          input_tokens_details: { cached_tokens: 28_160 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 12 },
        },
      },
      type: "response.completed",
    })}\n\n`;
    const chunks = [
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      completed.slice(0, 40),
      completed.slice(40),
    ];
    let timing: StreamTiming | undefined;
    const text = await new Response(
      observeStream(streamOf(chunks), (t) => {
        timing = t;
      })
    ).text();

    expect(text).toBe(chunks.join(""));
    expect(timing?.usage).toEqual({
      cachedTokens: 28_160,
      inputTokens: 28_762,
      outputTokens: 30,
      reasoningTokens: 12,
      serviceTier: "priority",
    });
    expect(timing?.firstChunkMs).toBeGreaterThanOrEqual(0);
  });

  it("reports once with unknown usage when the client cancels", async () => {
    const calls: StreamTiming[] = [];
    const observed = observeStream(
      streamOf(['data: {"type":"response.created"}\n\n']),
      (t) => calls.push(t)
    );
    await observed.cancel();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.usage).toEqual({});
  });
});
