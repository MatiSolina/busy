import assert from "node:assert/strict";
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
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const botId = "11111111-1111-4111-8111-111111111111";
const otherBotId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let history: typeof import("./lib/history-search");
let embeddings: typeof import("./lib/history-embeddings");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE);
    CREATE TABLE memory_metadata (
      bot_slug text NOT NULL,
      entry_id text NOT NULL,
      text text NOT NULL,
      session_id text,
      turn_id text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bot_slug, entry_id)
    );
    CREATE TYPE message_status AS ENUM ('pending', 'accepted', 'failed');
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivery_id text,
      file_ids jsonb NOT NULL DEFAULT '[]',
      status message_status NOT NULL DEFAULT 'pending',
      text text NOT NULL
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
    CREATE TABLE consultations (
      call_id text UNIQUE NOT NULL,
      child_session_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      from_bot_id uuid NOT NULL,
      id uuid PRIMARY KEY,
      parent_session_id text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      to_bot_id uuid
    );
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0018_history_search.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    bots: schema.bots,
    consultations: schema.consultations,
    db: () => database,
    events: schema.events,
    messages: schema.messages,
  }));
  vi.resetModules();
  history = await import("./lib/history-search");
  embeddings = await import("./lib/history-embeddings");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM consultations; DELETE FROM events; DELETE FROM messages; DELETE FROM memory_metadata; DELETE FROM history_embeddings; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug) VALUES ('${botId}', 'main-bot'), ('${otherBotId}', 'other-bot');
    INSERT INTO memory_metadata (bot_slug, entry_id, text, updated_at) VALUES
      ('main-bot', '1', 'User prefers short summaries.', '2026-11-02 12:04:00+00'),
      ('main-bot', '98', 'Updated memory fact.', '2026-11-02 12:05:00+00');
    INSERT INTO messages (id, bot_id, status, text, created_at) VALUES
      ('${userMessageId}', '${botId}', 'accepted', 'We decided to renew the contract.', '2026-11-02 12:00:00+00'),
      ('44444444-4444-4444-8444-444444444444', '${otherBotId}', 'accepted', 'Renew another bot record.', '2026-11-02 12:01:00+00');
    INSERT INTO events (at, bot_id, data, index, line, session_id, type) VALUES
      ('2026-11-02 12:01:00+00', '${botId}', '{"data":{"kind":"text","phase":"reply","value":"A context note before."}}', 0, 0, 'session-main', 'content.completed'),
      ('2026-11-02 12:02:00+00', '${botId}', '{"data":{"kind":"text","phase":"reply","value":"The contract renewal is ready."}}', 0, 1, 'session-main', 'content.completed'),
      ('2026-11-02 12:03:00+00', '${botId}', '{"data":{"kind":"text","phase":"reply","value":"Private consultation renewal."}}', 0, 2, 'session-child', 'content.completed');
    INSERT INTO consultations (call_id, child_session_id, from_bot_id, id, parent_session_id) VALUES
      ('peer-1', 'session-child', '${botId}', '55555555-5555-4555-8555-555555555555', 'session-main');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("history search", () => {
  it("reads both sides of the same conversation without repeating a microsecond anchor", async () => {
    await client.exec(`
      UPDATE messages SET delivery_id = 'owner-delivery', created_at = '2026-11-02 12:00:00.000123+00' WHERE id = '${userMessageId}';
      INSERT INTO events (at, bot_id, data, index, line, session_id, type) VALUES
        ('2026-11-02 12:00:00.000123+00', '${botId}', '{"data":{"deliveryId":"owner-delivery","turnId":"owner-turn"},"scope":{"turnId":"owner-turn"}}', 0, 10, 'session-main', 'delivery.consumed'),
        ('2026-11-02 12:00:00.000456+00', '${botId}', '{"data":{"kind":"text","phase":"reply","value":"A reply in the same millisecond."}}', 0, 11, 'session-main', 'content.completed'),
        ('2026-11-02 12:00:00.000456+00', '${botId}', '{"data":{"kind":"text","phase":"reply","value":"Another primary session must remain separate."}}', 0, 0, 'session-other', 'content.completed');
    `);
    const results = await history.searchHistory(botId, "contract");
    const result = results.find((item) => item.id === userMessageId);
    assert(result);
    const context = await history.aroundHistory(botId, result);
    expect(context.sessionId).toBe("session-main");
    expect(context.after.map((item) => item.text)).toContain(
      "A reply in the same millisecond."
    );
    expect(
      [...context.before, ...context.after].some(
        (item) => item.id === result.id
      )
    ).toBe(false);
    expect(
      [...context.before, ...context.after].every(
        (item) => item.sessionId === "session-main"
      )
    ).toBe(true);
  });

  it("searches user and assistant records while excluding consultation sessions", async () => {
    const results = await history.searchHistory(botId, "contract", {
      limit: 10,
    });
    expect(results.map((result) => result.text)).toEqual([
      "The contract renewal is ready.",
      "We decided to renew the contract.",
    ]);
    expect(results.every((result) => result.id !== "session-child:2:0")).toBe(
      true
    );
  });

  it("fuses an optional semantic ranking while retaining lexical fallback", async () => {
    const lexical = await history.searchHistory(botId, "contract", {
      limit: 10,
    });
    const semantic = await history.searchHistory(botId, "contract", {
      limit: 10,
      semantic: {
        search: async (_query, candidates) => ({
          candidates: [],
          scores: new Map([[candidates.at(-1)?.id ?? "", 1]]),
        }),
      },
    });
    assert(lexical[0]);
    expect(semantic).toHaveLength(lexical.length);
    expect(semantic.some((result) => result.semanticScore === 1)).toBe(true);
  });

  it("falls back to lexical results when the semantic provider fails", async () => {
    const results = await history.searchHistory(botId, "contract", {
      limit: 10,
      semantic: {
        search: () => Promise.reject(new Error("synthetic provider outage")),
      },
    });
    expect(results.length).toBeGreaterThan(0);
  });

  it("includes current bot memory facts in the same lexical search", async () => {
    const results = await history.searchHistory(botId, "short summaries", {
      limit: 10,
    });
    expect(results.map((result) => result.source)).toEqual(["memory"]);
    expect(results[0]?.text).toBe("User prefers short summaries.");
    assert(results[0]);
    const around = await history.aroundHistory(botId, results[0]);
    expect(around.id).toBe("main-bot:memory:1");
    expect(around.before).toHaveLength(0);
    expect(around.after).toHaveLength(0);
  });

  it("uses independent semantic candidates without leaking bots, consultations, deleted or stale rows", async () => {
    await client.exec(`
      INSERT INTO history_embeddings
        (bot_id, source, source_id, session_id, text, content_hash, model, embedding)
      VALUES
        ('${botId}', 'message', '${userMessageId}', NULL, 'We decided to renew the contract.', md5('We decided to renew the contract.'), 'test-model', '[1,0]'),
        ('${otherBotId}', 'message', '66666666-6666-4666-8666-666666666666', NULL, 'Private other bot fact.', md5('Private other bot fact.'), 'test-model', '[1,0]'),
        ('${botId}', 'event', 'session-child:2:0', 'session-child', 'Private consultation fact.', md5('Private consultation fact.'), 'test-model', '[1,0]'),
        ('${botId}', 'memory', 'main-bot:memory:1', NULL, 'User prefers short summaries.', md5('User prefers short summaries.'), 'test-model', '[0,1]'),
        ('${botId}', 'memory', 'main-bot:memory:98', NULL, 'Updated memory fact.', md5('stale memory text'), 'test-model', '[1,0]'),
        ('${botId}', 'memory', 'main-bot:memory:99', NULL, 'Deleted memory fact.', md5('Deleted memory fact.'), 'test-model', '[1,0]');
    `);
    const previousEnabled = process.env.HISTORY_EMBEDDINGS_ENABLED;
    const previousModel = process.env.HISTORY_EMBEDDING_MODEL;
    const previousKey = process.env.HISTORY_EMBEDDING_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.HISTORY_EMBEDDINGS_ENABLED = "1";
    process.env.HISTORY_EMBEDDING_MODEL = "test-model";
    process.env.HISTORY_EMBEDDING_API_KEY = "synthetic-key";
    globalThis.fetch = vi.fn((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string };
      const embedding = body.input.includes("short") ? [0, 1] : [1, 0];
      return Promise.resolve(
        Response.json({ data: [{ embedding, index: 0 }] })
      );
    });
    try {
      const results = await history.searchHistory(botId, "cotización", {
        limit: 10,
      });
      expect(results.map((result) => result.text)).toEqual([
        "We decided to renew the contract.",
      ]);
      const memoryResults = await history.searchHistory(
        botId,
        "short summaries",
        {
          limit: 10,
        }
      );
      expect(
        memoryResults.filter((result) => result.source === "memory")
      ).toHaveLength(1);
      expect(new Set(memoryResults.map((result) => result.id)).size).toBe(
        memoryResults.length
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnabled === undefined) {
        delete process.env.HISTORY_EMBEDDINGS_ENABLED;
      } else {
        process.env.HISTORY_EMBEDDINGS_ENABLED = previousEnabled;
      }
      if (previousModel === undefined) {
        delete process.env.HISTORY_EMBEDDING_MODEL;
      } else {
        process.env.HISTORY_EMBEDDING_MODEL = previousModel;
      }
      if (previousKey === undefined) {
        delete process.env.HISTORY_EMBEDDING_API_KEY;
      } else {
        process.env.HISTORY_EMBEDDING_API_KEY = previousKey;
      }
    }
  });

  it("stores source timestamps for semantic rows instead of indexing time", async () => {
    const previousEnabled = process.env.HISTORY_EMBEDDINGS_ENABLED;
    const previousModel = process.env.HISTORY_EMBEDDING_MODEL;
    const previousKey = process.env.HISTORY_EMBEDDING_API_KEY;
    const previousFetch = globalThis.fetch;
    process.env.HISTORY_EMBEDDINGS_ENABLED = "1";
    process.env.HISTORY_EMBEDDING_MODEL = "test-model";
    process.env.HISTORY_EMBEDDING_API_KEY = "synthetic-key";
    globalThis.fetch = vi.fn((_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return Promise.resolve(
        Response.json({
          data: body.input.map((_, index) => ({ embedding: [1, 0], index })),
        })
      );
    });
    try {
      await embeddings.historyEmbeddingBatch(botId);
      const rows = await client.query<{
        created_at: string | Date;
        source: string;
        source_id: string;
      }>(
        `SELECT source, source_id, created_at FROM history_embeddings WHERE bot_id = '${botId}' ORDER BY source, source_id`
      );
      const timestamp = (source: string, sourceId: string) => {
        const row = rows.rows.find(
          (candidate) =>
            candidate.source === source && candidate.source_id === sourceId
        );
        expect(row).toBeDefined();
        return new Date(row?.created_at ?? 0).toISOString();
      };
      expect(timestamp("message", userMessageId)).toBe(
        "2026-11-02T12:00:00.000Z"
      );
      expect(timestamp("event", "session-main:0:0")).toBe(
        "2026-11-02T12:01:00.000Z"
      );
      expect(timestamp("memory", "main-bot:memory:1")).toBe(
        "2026-11-02T12:04:00.000Z"
      );
    } finally {
      globalThis.fetch = previousFetch;
      if (previousEnabled === undefined) {
        delete process.env.HISTORY_EMBEDDINGS_ENABLED;
      } else {
        process.env.HISTORY_EMBEDDINGS_ENABLED = previousEnabled;
      }
      if (previousModel === undefined) {
        delete process.env.HISTORY_EMBEDDING_MODEL;
      } else {
        process.env.HISTORY_EMBEDDING_MODEL = previousModel;
      }
      if (previousKey === undefined) {
        delete process.env.HISTORY_EMBEDDING_API_KEY;
      } else {
        process.env.HISTORY_EMBEDDING_API_KEY = previousKey;
      }
    }
  });

  it("reads a bounded context window around a result", async () => {
    const [result] = await history.searchHistory(botId, "contract renewal", {
      limit: 10,
    });
    assert(result);
    const around = await history.aroundHistory(botId, result);
    expect(around.id).toBe(result.id);
    expect(around.before.length + around.after.length).toBeGreaterThanOrEqual(
      1
    );
  });
});
