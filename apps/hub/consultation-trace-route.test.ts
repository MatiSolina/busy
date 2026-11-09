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
import { bots, consultations, events } from "@/lib/db/schema";

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const PEER_ID = "22222222-2222-4222-8222-222222222222";
const CONSULTATION_ID = "33333333-3333-4333-8333-333333333333";
const CALL_ID = "chatcmpl-tool-qa";
const databaseState = vi.hoisted(() => ({
  cookies: vi.fn(),
  readSession: vi.fn(),
}));

vi.mock("next/headers", () => ({ cookies: databaseState.cookies }));
vi.mock("@/lib/auth/session", () => ({
  readSession: databaseState.readSession,
  SESSION_COOKIE: "busy_session",
}));

let client: PGlite;
let database: ReturnType<typeof drizzle>;
let route: typeof import("@/app/api/consultations/[id]/trace/route");

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret";
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL
    );
    CREATE TABLE consultations (
      call_id text NOT NULL UNIQUE,
      child_session_id text,
      created_at timestamptz NOT NULL,
      from_bot_id uuid NOT NULL,
      id uuid PRIMARY KEY,
      parent_session_id text NOT NULL,
      status text NOT NULL,
      to_bot_id uuid
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
  database = drizzle(client, { schema: { bots, consultations, events } });
  databaseState.cookies.mockResolvedValue({
    get: vi.fn(() => ({ value: "session" })),
  });
  databaseState.readSession.mockResolvedValue({ user: "mati" });
  vi.doMock("@/lib/db", () => ({
    bots,
    consultations,
    db: () => database,
    events,
  }));
  vi.resetModules();
  route = await import("@/app/api/consultations/[id]/trace/route");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM events; DELETE FROM consultations; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug) VALUES
      ('${BOT_ID}', 'qa-1104-gateway'),
      ('${PEER_ID}', 'qa-1104-grok');
  `);
  await database.insert(consultations).values({
    callId: CALL_ID,
    childSessionId: "child-session",
    createdAt: new Date("2026-11-05T14:00:00.000Z"),
    fromBotId: BOT_ID,
    id: CONSULTATION_ID,
    parentSessionId: "parent-session",
    status: "open",
    toBotId: PEER_ID,
  });
  await database.insert(events).values([
    {
      at: new Date("2026-11-05T14:00:01.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          name: "peer-1",
          owner: { callId: CALL_ID },
          sessionId: "child-session",
        },
        type: "child.opened",
      },
      index: 0,
      line: 0,
      sessionId: "parent-session",
      type: "child.opened",
    },
    {
      at: new Date("2026-11-05T14:00:04.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          callId: CALL_ID,
          outcome: "completed",
          output: "private output",
        },
        type: "call.settled",
      },
      index: 0,
      line: 1,
      sessionId: "parent-session",
      type: "call.settled",
    },
    {
      at: new Date("2026-11-05T14:00:05.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          owner: { callId: CALL_ID },
          sessionId: "other-child-session",
        },
        type: "child.opened",
      },
      index: 0,
      line: 2,
      sessionId: "parent-session",
      type: "child.opened",
    },
    {
      at: new Date("2026-11-05T14:00:02.000Z"),
      botId: BOT_ID,
      data: {
        data: { deliveryId: "delivery-child" },
        type: "delivery.admitted",
      },
      index: 0,
      line: 0,
      sessionId: "child-session",
      type: "delivery.admitted",
    },
    {
      at: new Date("2026-11-05T14:00:03.000Z"),
      botId: BOT_ID,
      data: {
        data: { deliveryId: "delivery-child", turnId: "turn-child" },
        scope: { turnId: "turn-child" },
        type: "delivery.consumed",
      },
      index: 0,
      line: 1,
      sessionId: "child-session",
      type: "delivery.consumed",
    },
    {
      at: new Date("2026-11-05T14:00:03.000Z"),
      botId: BOT_ID,
      data: {
        data: { turnId: "turn-child" },
        scope: { turnId: "turn-child" },
        type: "turn.started",
      },
      index: 0,
      line: 2,
      sessionId: "child-session",
      type: "turn.started",
    },
    {
      at: new Date("2026-11-05T14:00:03.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          modelId: "openai/gpt-5-mini",
          prompt: "private prompt",
          provider: "openai",
          runId: "run-child",
        },
        scope: { runId: "run-child", turnId: "turn-child" },
        type: "model.started",
      },
      index: 0,
      line: 3,
      sessionId: "child-session",
      type: "model.started",
    },
    {
      at: new Date("2026-11-05T14:00:04.000Z"),
      botId: BOT_ID,
      data: {
        data: { outcome: "completed", runId: "run-child" },
        scope: { runId: "run-child", turnId: "turn-child" },
        type: "model.settled",
      },
      index: 0,
      line: 4,
      sessionId: "child-session",
      type: "model.settled",
    },
    {
      at: new Date("2026-11-05T14:00:04.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          kind: "model",
          owner: { runId: "run-child" },
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        scope: { runId: "run-child", turnId: "turn-child" },
        type: "usage.recorded",
      },
      index: 0,
      line: 5,
      sessionId: "child-session",
      type: "usage.recorded",
    },
    {
      at: new Date("2026-11-05T14:00:05.000Z"),
      botId: BOT_ID,
      data: {
        data: { deliveryId: "delivery-child", outcome: "completed" },
        scope: { turnId: "turn-child" },
        type: "delivery.settled",
      },
      index: 0,
      line: 6,
      sessionId: "child-session",
      type: "delivery.settled",
    },
    {
      at: new Date("2026-11-05T14:00:05.000Z"),
      botId: BOT_ID,
      data: {
        data: { outcome: "completed", turnId: "turn-child" },
        scope: { turnId: "turn-child" },
        type: "turn.settled",
      },
      index: 0,
      line: 7,
      sessionId: "child-session",
      type: "turn.settled",
    },
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("consultation trace route", () => {
  it("returns bounded parent and child metadata without content", async () => {
    const response = await route.GET(
      new Request("https://busy.test/api/consultations/trace"),
      {
        params: Promise.resolve({ id: CONSULTATION_ID }),
      }
    );
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.complete).toBe(true);
    expect(body.consultation.callId).toBe(CALL_ID);
    expect(body.parent.call.outcome).toBe("completed");
    expect(body.parent.childOpenedAt).toBe("2026-11-05T14:00:01.000Z");
    expect(body.child.complete).toBe(true);
    expect(body.child.correlation.sessionId).toBe("child-session");
    expect(body.child.correlation.turnId).toBe("turn-child");
    expect(body.child.modelAttempts).toHaveLength(1);
    expect(body.child.modelAttempts[0]).toMatchObject({
      modelId: "openai/gpt-5-mini",
      runId: "run-child",
    });
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private output");
  });

  it("requires authentication", async () => {
    databaseState.readSession.mockResolvedValueOnce(null);
    const response = await route.GET(
      new Request("https://busy.test/api/consultations/trace"),
      {
        params: Promise.resolve({ id: CONSULTATION_ID }),
      }
    );
    expect(response.status).toBe(401);
  });
});
