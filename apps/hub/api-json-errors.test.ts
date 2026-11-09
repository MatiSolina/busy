import { beforeEach, describe, expect, it, vi } from "vitest";

// The routes documented in busybot.dev/openapi.json answer errors in JSON, never plain text.
const mocks = vi.hoisted(() => ({ getBot: vi.fn() }));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/chat/store", () => ({
  botCall: vi.fn(),
  cursorOf: vi.fn(),
  saver: vi.fn(),
}));
vi.mock("@/lib/chat/send", () => ({
  persistedEvents: vi.fn(),
  persistedTailEvents: vi.fn(),
}));
vi.mock("@/lib/eve/client", () => ({
  cancelTurn: vi.fn(),
  readStream: vi.fn(),
}));
vi.mock("@/lib/history-search", () => ({
  aroundHistory: vi.fn(),
  historySearchLimits: {
    defaultResults: 5,
    maxQueryLength: 200,
    maxResults: 20,
  },
  searchHistory: vi.fn(),
}));

const ctx = { params: Promise.resolve({ slug: "missing" }) };

/** What a client sees of an error: its status, its type and its code. */
async function errorOf(res: Response) {
  const body = (await res.json()) as { code?: string; error?: string };
  return {
    code: body.code,
    error: body.error,
    json: res.headers.get("content-type")?.includes("application/json"),
    status: res.status,
  };
}

const jsonError = (status: number, code: string) => ({
  code,
  error: code,
  json: true,
  status,
});

describe("documented routes answer errors in JSON", () => {
  beforeEach(() => mocks.getBot.mockReset());

  it("history: unknown bot", async () => {
    mocks.getBot.mockResolvedValue(null);
    const { GET } = await import("./app/api/bots/[slug]/history/route");
    expect(
      await errorOf(
        await GET(
          new Request("https://hub.test/api/bots/missing/history?q=x"),
          ctx
        )
      )
    ).toEqual(jsonError(404, "not_found"));
  });

  it("stop: bad body and unknown bot", async () => {
    const { POST } = await import("./app/api/bots/[slug]/stop/route");
    const stop = (body: unknown) =>
      POST(
        new Request("https://hub.test/api/bots/missing/stop", {
          body: JSON.stringify(body),
          method: "POST",
        }),
        ctx
      );
    expect(await errorOf(await stop({}))).toEqual(
      jsonError(400, "invalid_data")
    );
    mocks.getBot.mockResolvedValue(null);
    expect(await errorOf(await stop({ turnId: "t1" }))).toEqual(
      jsonError(404, "not_found")
    );
  });

  it("events: bot without a conversation yet", async () => {
    mocks.getBot.mockResolvedValue({ sessionId: null, status: "failed" });
    const { GET } = await import("./app/api/bots/[slug]/events/route");
    expect(
      await errorOf(
        await GET(new Request("https://hub.test/api/bots/missing/events"), ctx)
      )
    ).toEqual(jsonError(409, "pending"));
  });
});
