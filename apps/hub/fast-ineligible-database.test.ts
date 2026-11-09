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
import type { BotRow } from "./lib/db";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({ database: null as unknown }));
vi.mock("@/lib/db", async () => {
  const s = await import("./lib/db/schema");
  return { ...s, db: () => h.database };
});
vi.mock("@/lib/chat/send", () => ({ recentHistory: vi.fn() }));
vi.mock("@/lib/ai/subscription-store", () => ({
  getSubscriptionAccess: vi.fn(),
}));

const { fastIneligible } = await import("./lib/chat/fast-reply");

const botId = "11111111-1111-4111-8111-111111111111";
const bot = {
  billing: "gateway",
  historyPending: false,
  id: botId,
  model: "model/example",
  sessionId: "session-a",
} as BotRow;

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE events (
      session_id text NOT NULL, line integer NOT NULL, index integer NOT NULL,
      bot_id uuid NOT NULL, type text NOT NULL, data jsonb NOT NULL, at timestamptz NOT NULL,
      PRIMARY KEY (session_id, line, index)
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY, bot_id uuid NOT NULL, text text NOT NULL DEFAULT '',
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb, delivery_id text, client_context jsonb,
      status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE consultations (
      id uuid PRIMARY KEY, from_bot_id uuid, to_bot_id uuid, status text, created_at timestamptz
    );
    CREATE TABLE code_tasks (id uuid PRIMARY KEY, bot_id uuid, status text);
    CREATE TABLE firesides (id uuid PRIMARY KEY, bot_id uuid, status text);
  `);
  database = drizzle({ client, schema });
  h.database = database;
});

afterAll(async () => {
  await client.close();
});

let line = 0;
const fact = async (
  type: string,
  data: Record<string, unknown>,
  ageMs = 0,
  scope?: Record<string, unknown>
) => {
  line += 1;
  await database.insert(schema.events).values({
    at: new Date(Date.now() - ageMs),
    botId,
    data: { data, scope, type },
    index: 0,
    line,
    sessionId: "session-a",
    type,
  });
};

beforeEach(async () => {
  await database.delete(schema.events);
});

const messageId = "22222222-2222-4222-8222-222222222222";

describe("fastIneligible reads the open-turn projection (H-33)", () => {
  it("is free when the last turn settled", async () => {
    await fact("turn.started", { turnId: "t1" });
    await fact("turn.settled", { outcome: "completed", turnId: "t1" });
    await expect(fastIneligible(bot, messageId)).resolves.toBeNull();
  });

  it("stays busy for an orphan or paused turn, even an old one", async () => {
    await fact("turn.started", { turnId: "t1" }, 60 * 60_000);
    await expect(fastIneligible(bot, messageId)).resolves.toBe("busy");
    await fact("turn.paused", {}, 60 * 60_000, { turnId: "t1" });
    await expect(fastIneligible(bot, messageId)).resolves.toBe("busy");
  });

  it("stays busy for an admitted message no turn took", async () => {
    await fact("delivery.admitted", { deliveryId: "d1" });
    await expect(fastIneligible(bot, messageId)).resolves.toBe("busy");
  });

  it("stops answering in a session eve ended, without a fabricated settle", async () => {
    await fact("turn.started", { turnId: "t1" });
    await fact("session.ended", { outcome: "failed" });
    await expect(fastIneligible(bot, messageId)).resolves.toBe("no_session");
  });
});
