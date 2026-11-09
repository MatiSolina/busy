import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { bots, events, memories } from "@/lib/db/schema";

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const FOREIGN_ID = "22222222-2222-4222-8222-222222222222";
const BOT = "assistant";
const CONTENT = "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: fact\n";

let client: PGlite;
let database: ReturnType<
  typeof drizzle<{
    bots: typeof bots;
    events: typeof events;
    memories: typeof memories;
  }>
>;
let route: typeof import("@/app/api/bot/memory/route");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Assistant'
    );
    CREATE TABLE memories (
      bot_slug text PRIMARY KEY,
      content text NOT NULL,
      version integer NOT NULL
    );
    CREATE TABLE events (
      at timestamptz NOT NULL,
      bot_id uuid NOT NULL,
      data jsonb NOT NULL,
      index integer NOT NULL,
      line integer NOT NULL,
      session_id text NOT NULL,
      type text NOT NULL,
      PRIMARY KEY (session_id, line, index)
    );
    INSERT INTO bots (id, slug) VALUES
      ('${BOT_ID}', '${BOT}'),
      ('${FOREIGN_ID}', 'foreign');
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0017_memory_metadata.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema: { bots, events, memories } });
  vi.doMock("@/lib/bot-auth", () => ({
    botFromRequest: vi.fn().mockResolvedValue({ slug: BOT }),
  }));
  vi.doMock("@/lib/db", () => ({ bots, db: () => database, events, memories }));
  vi.resetModules();
  route = await import("@/app/api/bot/memory/route");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM memory_metadata_events; DELETE FROM memory_metadata; DELETE FROM memories; DELETE FROM events;"
  );
});

afterAll(async () => {
  await client.close();
});

describe("bot memory provenance route", () => {
  it("accepts only an exact turn.started event for the authenticated bot", async () => {
    const put = await route.PUT(
      new Request("https://hub.test/api/bot/memory", {
        body: JSON.stringify({ content: CONTENT, expectedVersion: null }),
        method: "PUT",
      })
    );
    expect(put.status).toBe(200);

    await client.exec(`
      INSERT INTO events (at, bot_id, data, index, line, session_id, type)
      VALUES (
        now(), '${BOT_ID}',
        '{"scope":{"turnId":"turn-1"},"data":{"turnId":"turn-1"}}',
        0, 0, 'session-1', 'turn.started'
      );
      INSERT INTO events (at, bot_id, data, index, line, session_id, type)
      VALUES (
        now(), '${FOREIGN_ID}',
        '{"scope":{"turnId":"foreign-turn"}}',
        0, 0, 'foreign-session', 'turn.started'
      );
    `);

    const verified = await route.POST(
      new Request("https://hub.test/api/bot/memory", {
        body: JSON.stringify({
          content: CONTENT,
          sessionId: "session-1",
          turnId: "turn-1",
          version: 1,
        }),
        method: "POST",
      })
    );
    expect((await verified.json()).sourceStatus).toBe("trusted_eve_turn");

    const forged = await route.POST(
      new Request("https://hub.test/api/bot/memory", {
        body: JSON.stringify({
          content: CONTENT,
          sessionId: "session-1",
          turnId: "%",
          version: 1,
        }),
        method: "POST",
      })
    );
    expect((await forged.json()).sourceStatus).toBe("bot_identity_only");

    const foreign = await route.POST(
      new Request("https://hub.test/api/bot/memory", {
        body: JSON.stringify({
          content: CONTENT,
          sessionId: "foreign-session",
          turnId: "foreign-turn",
          version: 1,
        }),
        method: "POST",
      })
    );
    expect((await foreign.json()).sourceStatus).toBe("bot_identity_only");
  });
});
