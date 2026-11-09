import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { events, messages } from "@/lib/db/schema";

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const BOT_SLUG = "contracts";
const MESSAGE_A = "22222222-2222-4222-8222-222222222222";
const MESSAGE_B = "33333333-3333-4333-8333-333333333333";
const databaseState = vi.hoisted(() => ({
  cookies: vi.fn(),
  getBot: vi.fn(),
  readSession: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: databaseState.cookies }));
vi.mock("@/lib/auth/session", () => ({
  readSession: databaseState.readSession,
  SESSION_COOKIE: "busy_session",
}));
vi.mock("@/lib/bots/service", () => ({ getBot: databaseState.getBot }));

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let route: typeof import("@/app/api/bots/[slug]/messages/[id]/trace/route");

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret";
  client = new PGlite();
  await client.exec(`
    CREATE TABLE messages (
      bot_id uuid NOT NULL,
      created_at timestamptz NOT NULL,
      delivery_id text,
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      id uuid PRIMARY KEY,
      payload_hash text,
      status text NOT NULL,
      text text NOT NULL,
      client_context jsonb,
      selected_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      session_id text,
      attempt integer NOT NULL DEFAULT 0,
      failure text,
      check_after timestamptz,
      checks integer NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      at timestamptz NOT NULL,
      bot_id uuid NOT NULL,
      data jsonb NOT NULL,
      index integer NOT NULL,
      line integer NOT NULL,
      session_id text NOT NULL,
      type text NOT NULL
    );
  `);
  database = drizzle(client, { schema: { events, messages } });
  databaseState.cookies.mockResolvedValue({
    get: vi.fn(() => ({ value: "session" })),
  });
  databaseState.readSession.mockResolvedValue({ user: "mati" });
  databaseState.getBot.mockResolvedValue({
    billing: "gateway",
    id: BOT_ID,
    slug: BOT_SLUG,
    status: "ready",
  });
  vi.doMock("@/lib/db", () => ({ db: () => database, events, messages }));
  vi.resetModules();
  route = await import("@/app/api/bots/[slug]/messages/[id]/trace/route");
});

beforeEach(async () => {
  await client.exec("DELETE FROM events; DELETE FROM messages;");
  await database.insert(messages).values([
    {
      botId: BOT_ID,
      createdAt: new Date("2026-11-04T18:00:00.000Z"),
      deliveryId: "delivery-a",
      fileIds: [],
      id: MESSAGE_A,
      payloadHash: null,
      status: "accepted",
      text: "secret prompt must not be returned",
    },
    {
      botId: BOT_ID,
      createdAt: new Date("2026-11-04T18:01:00.000Z"),
      deliveryId: "delivery-b",
      fileIds: [],
      id: MESSAGE_B,
      payloadHash: null,
      status: "accepted",
      text: "another prompt",
    },
  ]);
  await database.insert(events).values([
    {
      at: new Date("2026-11-04T18:00:01.000Z"),
      botId: BOT_ID,
      data: { data: { deliveryId: "delivery-a" }, type: "delivery.admitted" },
      index: 0,
      line: 0,
      sessionId: "session-1",
      type: "delivery.admitted",
    },
    {
      at: new Date("2026-11-04T18:00:02.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          trace: {
            spanId: "aaaaaaaaaaaaaaaa",
            traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
          turnId: "turn-a",
        },
        scope: { turnId: "turn-a" },
        type: "turn.started",
      },
      index: 0,
      line: 1,
      sessionId: "session-1",
      type: "turn.started",
    },
    {
      at: new Date("2026-11-04T18:00:02.000Z"),
      botId: BOT_ID,
      data: {
        data: { deliveryId: "delivery-a", turnId: "turn-a" },
        scope: { turnId: "turn-a" },
        type: "delivery.consumed",
      },
      index: 0,
      line: 1,
      sessionId: "session-1",
      type: "delivery.consumed",
    },
    {
      at: new Date("2026-11-04T18:00:03.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          attempt: 0,
          modelId: "openai/gpt-5-mini",
          prompt: "do not return this prompt",
          provider: "openai",
          runId: "run-a",
        },
        scope: { runId: "run-a", turnId: "turn-a" },
        type: "model.started",
      },
      index: 0,
      line: 2,
      sessionId: "session-1",
      type: "model.started",
    },
    {
      at: new Date("2026-11-04T18:00:04.000Z"),
      botId: BOT_ID,
      data: {
        data: { callId: "call-a", input: "secret tool args" },
        scope: { runId: "run-a", turnId: "turn-a" },
        type: "call.requested",
      },
      index: 0,
      line: 3,
      sessionId: "session-1",
      type: "call.requested",
    },
    {
      at: new Date("2026-11-04T18:00:05.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          callId: "call-a",
          outcome: "completed",
          output: "secret tool output",
        },
        scope: { runId: "run-a", turnId: "turn-a" },
        type: "call.settled",
      },
      index: 0,
      line: 4,
      sessionId: "session-1",
      type: "call.settled",
    },
    {
      at: new Date("2026-11-04T18:00:06.000Z"),
      botId: BOT_ID,
      data: {
        data: { outcome: "completed", runId: "run-a" },
        scope: { runId: "run-a", turnId: "turn-a" },
        type: "model.settled",
      },
      index: 0,
      line: 5,
      sessionId: "session-1",
      type: "model.settled",
    },
    {
      at: new Date("2026-11-04T18:00:06.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          kind: "model",
          owner: { runId: "run-a" },
          usage: {
            cacheReadTokens: 5,
            cacheWriteTokens: 6,
            costUsd: 0.25,
            inputTokens: 100,
            outputTokens: 20,
          },
        },
        scope: { runId: "run-a", turnId: "turn-a" },
        type: "usage.recorded",
      },
      index: 1,
      line: 5,
      sessionId: "session-1",
      type: "usage.recorded",
    },
    {
      at: new Date("2026-11-04T18:00:07.000Z"),
      botId: BOT_ID,
      data: {
        data: { outcome: "completed", turnId: "turn-a" },
        scope: { turnId: "turn-a" },
        type: "turn.settled",
      },
      index: 0,
      line: 6,
      sessionId: "session-1",
      type: "turn.settled",
    },
    {
      at: new Date("2026-11-04T18:00:07.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          deliveryId: "delivery-a",
          outcome: "handled",
          turnId: "turn-a",
        },
        type: "delivery.settled",
      },
      index: 0,
      line: 6,
      sessionId: "session-1",
      type: "delivery.settled",
    },
    {
      at: new Date("2026-11-04T18:01:01.000Z"),
      botId: BOT_ID,
      data: { data: { deliveryId: "delivery-b" }, type: "delivery.admitted" },
      index: 0,
      line: 7,
      sessionId: "session-1",
      type: "delivery.admitted",
    },
    {
      at: new Date("2026-11-04T18:01:02.000Z"),
      botId: BOT_ID,
      data: {
        data: { turnId: "turn-b" },
        scope: { turnId: "turn-b" },
        type: "turn.started",
      },
      index: 0,
      line: 8,
      sessionId: "session-1",
      type: "turn.started",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

const ctx = (id: string) => ({
  params: Promise.resolve({ id, slug: BOT_SLUG }),
});

describe("message trace metadata route", () => {
  it("returns the exact delivery timeline without message or tool content", async () => {
    const response = await route.GET(
      new Request(
        `https://busy.test/api/bots/${BOT_SLUG}/messages/${MESSAGE_A}/trace`
      ),
      ctx(MESSAGE_A)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.correlation).toMatchObject({
      callIds: ["call-a"],
      deliveryId: "delivery-a",
      sessionId: "session-1",
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      turnId: "turn-a",
    });
    expect(body.correlation.callIds).not.toContain("call-b");
    expect(body.stages.turn.durationMs).toBe(5000);
    expect(body.stages.tools[0]).toMatchObject({
      callId: "call-a",
      durationMs: 1000,
    });
    expect(body.stages.modelAttempts[0]).toMatchObject({
      modelId: "openai/gpt-5-mini",
      provider: "openai",
      usage: { inputTokens: 100, outputTokens: 20 },
    });
    expect(body.usage).toMatchObject({
      coverage: { incomplete: false, observedRecords: 1 },
      totals: { costUsd: 0.25, inputTokens: 100, outputTokens: 20 },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret prompt");
    expect(serialized).not.toContain("secret tool args");
    expect(serialized).not.toContain("secret tool output");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("returns incomplete metadata before Eve has emitted delivery events", async () => {
    await client.exec(
      "UPDATE messages SET delivery_id = 'delivery-pending' WHERE id = '33333333-3333-4333-8333-333333333333'"
    );
    const response = await route.GET(
      new Request(
        `https://busy.test/api/bots/${BOT_SLUG}/messages/${MESSAGE_B}/trace`
      ),
      ctx(MESSAGE_B)
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.complete).toBe(false);
    expect(body.missing).toContain("delivery.admitted");
    expect(body.correlation.sessionId).toBeNull();
  });

  it("enforces authentication and bot/message ownership", async () => {
    databaseState.readSession.mockResolvedValueOnce(null);
    const unauthorized = await route.GET(
      new Request(
        `https://busy.test/api/bots/${BOT_SLUG}/messages/${MESSAGE_A}/trace`
      ),
      ctx(MESSAGE_A)
    );
    expect(unauthorized.status).toBe(401);

    databaseState.readSession.mockResolvedValue({ user: "mati" });
    databaseState.getBot.mockResolvedValueOnce(null);
    const missing = await route.GET(
      new Request(
        `https://busy.test/api/bots/${BOT_SLUG}/messages/${MESSAGE_A}/trace`
      ),
      ctx(MESSAGE_A)
    );
    expect(missing.status).toBe(404);
  });
});
