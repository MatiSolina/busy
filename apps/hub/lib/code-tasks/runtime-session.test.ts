import {
  createFxAgent,
  type FxAgentHostTool,
  type FxStreamLine,
  memory,
} from "libfx";
import { afterEach, describe, expect, it } from "vitest";
import { fxMessageId } from "./message-id";

const MODEL = "busy/test-model";
const FX_SAFE_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/u;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function finish(reason: "stop" | "tool-calls") {
  return {
    finishReason: { raw: reason, unified: reason },
    type: "finish",
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
  };
}

function answer(text: string) {
  return [{ delta: text, id: "answer", type: "text-delta" }, finish("stop")];
}

function toolCall(id: string, name: string, input: Record<string, unknown>) {
  return [
    { input, toolCallId: id, toolName: name, type: "tool-call" },
    finish("tool-calls"),
  ];
}

function sse(
  frames: readonly Record<string, unknown>[],
  options: { holdOpen?: boolean; signal?: AbortSignal } = {}
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      options.signal?.removeEventListener("abort", () => undefined);
    },
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
        );
      }
      if (!options.holdOpen) {
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      const close = () => {
        options.signal?.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          // The consumer may have cancelled the stream already.
        }
      };
      options.signal?.addEventListener("abort", close, { once: true });
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status: 200,
  });
}

function textOf(message: { content?: unknown }) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
    )
    .map((part) => part.text)
    .join("");
}

function userTexts(prompt: unknown) {
  if (!Array.isArray(prompt)) {
    return [];
  }
  return prompt
    .filter(
      (message): message is { role: "user"; content?: unknown } =>
        !!message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "user"
    )
    .map(textOf);
}

function streamLines(
  session: { stream: (cursor?: number) => ReadableStream<Uint8Array> },
  done: (line: FxStreamLine) => boolean
) {
  return (async () => {
    const reader = session.stream(0).getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    const lines: FxStreamLine[] = [];
    const deadline = Date.now() + 5000;
    const readNext = async (): Promise<void> => {
      if (lines.some(done)) {
        return;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("timed out waiting for libfx session stream");
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const read = reader.read();
      const timedOut = new Promise<ReadableStreamReadResult<Uint8Array>>(
        (_, reject) => {
          timeout = setTimeout(
            () =>
              reject(new Error("timed out waiting for libfx session stream")),
            remaining
          );
        }
      );
      const { value, done: ended } = await Promise.race([read, timedOut]);
      if (timeout) {
        clearTimeout(timeout);
      }
      if (ended) {
        return;
      }
      buffered += decoder.decode(value, { stream: true });
      for (
        let index = buffered.indexOf("\n");
        index >= 0;
        index = buffered.indexOf("\n")
      ) {
        const line = buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
        if (line) {
          lines.push(JSON.parse(line) as FxStreamLine);
        }
      }
      await readNext();
    };
    try {
      await readNext();
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return lines;
  })();
}

function makeAgent(
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  tools?: FxAgentHostTool[]
) {
  return createFxAgent({
    apiKey: "synthetic-key",
    durability: memory({ maxDurationMs: 5000, reserveMs: 250 }),
    fetch: fetcher,
    model: MODEL,
    modelCatalog: [{ id: MODEL }],
    tools,
  });
}

const agents: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.close()));
});

describe("libfx durable code-task session", () => {
  it("turns a legacy outbox id into a distinct SDK-safe message id", async () => {
    const raw = "code-task:legacy:start";
    const messageId = fxMessageId(raw);
    expect(messageId).toMatch(FX_SAFE_MESSAGE_ID_PATTERN);
    expect(messageId).not.toBe(fxMessageId("code-task-legacy-start"));
    const agent = makeAgent(() => Promise.resolve(sse(answer("done"))));
    agents.push(agent);
    const turn = agent.session("wrun_legacy").prompt("probe", { messageId });
    await expect(turn.accepted).resolves.toMatchObject({
      messageId,
      sessionId: "wrun_legacy",
    });
    await expect(turn.result).resolves.toMatchObject({ messageId });
  }, 20_000);

  it("deduplicates a retried prompt by messageId without a second model request", async () => {
    let requests = 0;
    const fetcher = (_input: string, init: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init.body)) as { prompt: unknown };
      expect(userTexts(body.prompt)).toContain("once");
      return Promise.resolve(sse(answer("done")));
    };
    const agent = makeAgent(fetcher);
    agents.push(agent);
    const session = agent.session();

    const first = await session.prompt("once", {
      messageId: "code-task-prompt",
    }).result;
    const repeated = await session.prompt("once", {
      messageId: "code-task-prompt",
    }).result;

    expect(first.stopReason).toBe("end_turn");
    expect(repeated).toMatchObject({
      messageId: "code-task-prompt",
      repeated: true,
      stopReason: "end_turn",
    });
    expect(requests).toBe(1);
  }, 20_000);

  it("consumes a steer during an active tool in the same session", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let requests = 0;
    const hold: FxAgentHostTool<{ value: string }> = {
      description: "Hold until the test releases the tool.",
      execute: async ({ value }) => {
        started.resolve();
        await release.promise;
        return `released:${value}`;
      },
      idempotent: true,
      inputSchema: {
        properties: { value: { type: "string" } },
        type: "object",
      },
      name: "hold",
    };
    const fetcher = (_input: string, init: RequestInit) => {
      requests += 1;
      const body = JSON.parse(String(init.body)) as { prompt: unknown };
      const users = userTexts(body.prompt);
      if (requests === 1) {
        return Promise.resolve(
          sse(toolCall("hold-1", "hold", { value: "work" }))
        );
      }
      expect(users.some((text) => text.includes("steer while busy"))).toBe(
        true
      );
      return Promise.resolve(sse(answer("finished")));
    };
    const agent = makeAgent(fetcher, [hold]);
    agents.push(agent);
    const session = agent.session();
    const turn = session.prompt("start", { messageId: "turn-opener" });
    await started.promise;

    const steer = session.steer("steer while busy", {
      messageId: "steer-while-tool",
    });
    release.resolve();
    await expect(steer).resolves.toEqual({ messageId: "steer-while-tool" });
    await expect(turn.result).resolves.toMatchObject({
      messageId: "turn-opener",
      stopReason: "end_turn",
    });

    const lines = await streamLines(
      session,
      (line) => line.type === "turn_end" && line.messageId === "turn-opener"
    );
    const joined = lines.filter(
      (line): line is FxStreamLine & { type: "user_message" } =>
        line.type === "user_message"
    );
    expect(joined).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "steer-while-tool",
          messageId: "turn-opener",
        }),
      ])
    );
    expect(lines.find((line) => line.type === "turn_end")?.messageId).toBe(
      "turn-opener"
    );
    expect(requests).toBe(2);
  }, 20_000);

  it("cancels an active model, then resumes idle without a new model request", async () => {
    const modelStarted = deferred<void>();
    let requests = 0;
    const fetcher = (_input: string, init: RequestInit) => {
      requests += 1;
      modelStarted.resolve();
      return Promise.resolve(
        sse([{ delta: "partial", id: "partial", type: "text-delta" }], {
          holdOpen: true,
          signal: init.signal ?? undefined,
        })
      );
    };
    const agent = makeAgent(fetcher);
    agents.push(agent);
    const session = agent.session();
    const turn = session.prompt("cancel me", { messageId: "cancelled-turn" });
    await modelStarted.promise;
    await session.cancel();
    await expect(turn.result).resolves.toMatchObject({
      messageId: "cancelled-turn",
      stopReason: "cancelled",
    });

    const resumed = await session.resume().result;
    expect(resumed.stopReason).toBe("idle");
    expect(requests).toBe(1);

    const lines = await streamLines(session, (line) => line.type === "idle");
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: expect.any(String),
          type: "idle",
        }),
      ])
    );
  }, 20_000);
});
