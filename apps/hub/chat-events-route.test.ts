import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  botCall: vi.fn(),
  cursorOf: vi.fn(),
  getBot: vi.fn(),
  logChatObservation: vi.fn(),
  persistedEvents: vi.fn(),
  readStream: vi.fn(),
  saver: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/send", () => ({
  persistedEvents: mocks.persistedEvents,
}));
vi.mock("@/lib/chat/store", () => ({
  botCall: mocks.botCall,
  cursorOf: mocks.cursorOf,
  saver: mocks.saver,
}));
vi.mock("@/lib/eve/client", () => ({ readStream: mocks.readStream }));
vi.mock("@/lib/chat/observability", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/chat/observability")
  >("@/lib/chat/observability");
  return { ...actual, logChatObservation: mocks.logChatObservation };
});

const sessionId = "session-1";
const bot = {
  billing: "gateway" as const,
  id: "11111111-1111-4111-8111-111111111111",
  sessionId,
  slug: "contract-desk",
  status: "ready" as const,
};

function fact(line: number, value: string) {
  return {
    data: { value },
    index: 0,
    line,
    type: "content.completed",
  };
}

function streamRecord(line: number, value: string) {
  return {
    line,
    record: {
      facts: [{ data: { value }, type: "content.completed" }],
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  marker: string
): Promise<string> {
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes(marker)) {
    // biome-ignore lint/performance/noAwaitInLoops: SSE chunks must be consumed in wire order.
    const result = await reader.read();
    if (result.done) {
      break;
    }
    body += decoder.decode(result.value, { stream: true });
  }
  return body;
}

async function waitForSettledStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  streamFinished: Promise<void>
): Promise<void> {
  await reader.cancel();
  await streamFinished;
}

describe("chat events route contract", () => {
  let cursor = 2;
  let saved: Array<{ line: number; nextLine: number }>;
  let firstStreamFinished: Promise<void>;
  let secondStreamFinished: Promise<void>;

  beforeEach(() => {
    vi.resetAllMocks();
    cursor = 2;
    saved = [];
    mocks.getBot.mockResolvedValue(bot);
    mocks.botCall.mockReturnValue({
      token: () => Promise.resolve("test-token"),
      url: "https://contract-desk.example.com",
    });
    mocks.cursorOf.mockImplementation(async () => cursor);
    mocks.persistedEvents.mockImplementation(
      (_session: string, after: number) => {
        if (after < 1) {
          return [fact(1, "stored")];
        }
        if (after < 2) {
          return [fact(2, "live")];
        }
        return [];
      }
    );
    mocks.saver.mockImplementation(
      () => (rows: Array<{ line: number }>, nextLine: number) => {
        saved.push({ line: rows[0]?.line ?? -1, nextLine });
        cursor = Math.max(cursor, nextLine);
      }
    );
    firstStreamFinished = new Promise<void>(() => undefined);
    secondStreamFinished = new Promise<void>(() => undefined);
    let streamCall = 0;
    mocks.readStream.mockImplementation(
      (
        _call: unknown,
        _session: string,
        startIndex: number,
        _follow: boolean,
        signal: AbortSignal
      ) => {
        streamCall += 1;
        let finish!: () => void;
        const finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
        if (streamCall === 1) {
          firstStreamFinished = finished;
        } else {
          secondStreamFinished = finished;
        }
        return (async function* () {
          yield streamRecord(startIndex, startIndex === 2 ? "live" : "next");
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          finish();
        })();
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("replays stored rows, persists live rows, and resumes after disconnect", async () => {
    const { GET } = await import("./app/api/bots/[slug]/events/route");
    const params = { params: Promise.resolve({ slug: bot.slug }) };
    const firstResponse = await GET(
      new Request(
        `https://busy.test/api/bots/${bot.slug}/events?session=${sessionId}&after=0`,
        { headers: { "x-request-id": "route-contract-1" } }
      ),
      params
    );
    const firstReader = firstResponse.body?.getReader();
    expect(firstReader).toBeDefined();
    const firstBodyPromise = readUntil(
      firstReader as ReadableStreamDefaultReader<Uint8Array>,
      "id: 2\n"
    );
    await vi.waitFor(() => expect(saved).toEqual([{ line: 2, nextLine: 3 }]));
    const firstBody = await firstBodyPromise;
    expect(firstBody).toContain(
      'event: session\ndata: {"sessionId":"session-1"}'
    );
    expect(firstBody).toContain(
      'id: 1\nevent: fact\ndata: {"data":{"value":"stored"}'
    );
    expect(firstBody).toContain(
      'id: 2\nevent: fact\ndata: {"data":{"data":{"value":"live"}'
    );
    await waitForSettledStream(
      firstReader as ReadableStreamDefaultReader<Uint8Array>,
      firstStreamFinished
    );

    const secondResponse = await GET(
      new Request(
        `https://busy.test/api/bots/${bot.slug}/events?session=${sessionId}&after=2`,
        { headers: { "x-request-id": "route-contract-2" } }
      ),
      params
    );
    const secondReader = secondResponse.body?.getReader();
    expect(secondReader).toBeDefined();
    const secondBodyPromise = readUntil(
      secondReader as ReadableStreamDefaultReader<Uint8Array>,
      "id: 3\n"
    );
    await vi.waitFor(() =>
      expect(saved).toEqual([
        { line: 2, nextLine: 3 },
        { line: 3, nextLine: 4 },
      ])
    );
    const secondBody = await secondBodyPromise;
    expect(secondBody).toContain(
      'event: session\ndata: {"sessionId":"session-1"}'
    );
    expect(secondBody).not.toContain('"value":"live"');
    expect(secondBody).toContain(
      'id: 3\nevent: fact\ndata: {"data":{"data":{"value":"next"}'
    );
    await waitForSettledStream(
      secondReader as ReadableStreamDefaultReader<Uint8Array>,
      secondStreamFinished
    );

    expect(mocks.persistedEvents).toHaveBeenNthCalledWith(1, sessionId, 0);
    expect(mocks.persistedEvents).toHaveBeenNthCalledWith(2, sessionId, 2);
    expect(mocks.readStream).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      sessionId,
      2,
      true,
      expect.any(AbortSignal)
    );
    expect(mocks.readStream).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      sessionId,
      3,
      true,
      expect.any(AbortSignal)
    );
    expect(mocks.logChatObservation).not.toHaveBeenCalledWith(
      "chat.stream",
      expect.objectContaining({ errorCode: "Error" })
    );
  });
});
