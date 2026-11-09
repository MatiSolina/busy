import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
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
import { FAST_INDEX_BASE } from "./lib/chat/fast-path";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema map to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({ db: vi.fn() }));
vi.mock("./lib/db", async () => ({ ...schema, db: h.db }));
vi.mock("./lib/chat/send", () => ({ recentHistory: async () => "" }));

const botId = "11111111-1111-4111-8111-111111111111";
const sessionId = "session-fast";
const ids = [
  "22222222-2222-4222-8222-222222222221",
  "22222222-2222-4222-8222-222222222222",
  "22222222-2222-4222-8222-222222222223",
];
const bot = {
  billing: "gateway",
  description: "",
  historyPending: false,
  id: botId,
  instructions: "",
  model: "m",
  name: "Ana",
  sessionId,
  slug: "ana",
} as never;

let client: PGlite;
let fast: typeof import("./lib/chat/fast-reply");
let slots: typeof import("./lib/chat/fast-slots");

const usage = {
  inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
  outputTokens: { reasoning: 0, text: 1, total: 1 },
};
const finish = {
  finishReason: { raw: undefined, unified: "stop" },
  type: "finish",
  usage,
};

/** A model that reports it was reached, then waits for `gate` before answering. */
function gated(gate: Promise<void>, reached: () => void, chunks: unknown[]) {
  return new MockLanguageModelV4({
    doStream: async () => {
      reached();
      await gate;
      return {
        stream: simulateReadableStream({
          chunks: [...chunks, finish] as never,
        }),
      };
    },
  });
}
const reply = (value: string) => [
  { id: "t", type: "text-start" },
  { delta: value, id: "t", type: "text-delta" },
  { id: "t", type: "text-end" },
];
const escalate = {
  input: "{}",
  toolCallId: "c1",
  toolName: "escalate",
  type: "tool-call",
};

const query = async (sql: string) => (await client.query(sql)).rows;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE events (at timestamptz NOT NULL, bot_id uuid NOT NULL, data jsonb NOT NULL,
      index integer NOT NULL, line integer NOT NULL, session_id text NOT NULL, type text NOT NULL,
      PRIMARY KEY (session_id, line, index));
    CREATE TABLE cursors (bot_id uuid NOT NULL, next_line integer NOT NULL DEFAULT 0,
      session_id text PRIMARY KEY);
    CREATE TYPE message_status AS ENUM ('pending', 'accepted', 'failed');
    CREATE TABLE messages (bot_id uuid NOT NULL, client_context jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), delivery_id text,
      file_ids jsonb NOT NULL DEFAULT '[]', id uuid PRIMARY KEY, payload_hash text,
      status message_status NOT NULL DEFAULT 'pending', text text NOT NULL);
    CREATE TABLE memories (bot_slug text PRIMARY KEY, content text NOT NULL,
      version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
    -- persistAck checks the bot still holds the session the ack was drafted in (#196).
    CREATE TABLE bots (id uuid PRIMARY KEY, session_id text);
  `);
  await client.query("INSERT INTO bots (id, session_id) VALUES ($1, $2)", [
    botId,
    sessionId,
  ]);
  await client.exec(
    readFileSync(
      new URL("./drizzle/0033_fast_slot_reservations.sql", import.meta.url),
      "utf8"
    )
  );
  h.db.mockReturnValue(drizzle(client, { schema }));
  fast = await import("./lib/chat/fast-reply");
  slots = await import("./lib/chat/fast-slots");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM events; DELETE FROM cursors; DELETE FROM messages; DELETE FROM fast_slot_reservations;"
  );
  await client.query(
    "INSERT INTO cursors (bot_id, next_line, session_id) VALUES ($1, 8, $2)",
    [botId, sessionId]
  );
  await client.query(
    "INSERT INTO messages (bot_id, id, text) SELECT $1, unnest($2::uuid[]), 'hi'",
    [botId, ids]
  );
});

afterAll(async () => {
  await client.close();
});

describe("fast-path slot allocator (H-34)", () => {
  it("gives two concurrent replies, both held before storing, distinct slots and no key violation", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    let bothReached: () => void = () => undefined;
    const reachedBoth = new Promise<void>((resolve) => {
      bothReached = resolve;
    });
    const reached = () => {
      arrived += 1;
      if (arrived === 2) {
        bothReached();
      }
    };
    const runs = [0, 1].map((n) =>
      fast.runFastReply(
        {
          ack: false,
          bot,
          messageId: ids[n],
          model: gated(gate, reached, reply(`answer ${n}`)),
          text: "hi",
        },
        () => undefined
      )
    );
    // Both requests reserved their slot and are inside the model; nothing is stored yet.
    await reachedBoth;
    expect(await query("SELECT * FROM events")).toHaveLength(0);
    const reserved = await query(
      "SELECT line, slot_index FROM fast_slot_reservations ORDER BY slot_index"
    );
    expect(reserved).toEqual([
      { line: 7, slot_index: FAST_INDEX_BASE },
      { line: 7, slot_index: FAST_INDEX_BASE + 4 },
    ]);
    release();
    const results = await Promise.all(runs);
    expect(results.map((r) => r.escalated)).toEqual([false, false]);
    const rows = await query(
      "SELECT line, index - 1000000000 AS offset, type FROM events ORDER BY index"
    );
    expect(rows.map((r) => (r as { offset: number }).offset)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(
      await query(
        "SELECT status, delivery_id FROM messages WHERE status = 'accepted'"
      )
    ).toHaveLength(2);
    // Consumed with the events: nothing stays reserved.
    expect(await query("SELECT * FROM fast_slot_reservations")).toHaveLength(0);
  });

  it("frees an escalated reply's slot, and the next exchange packs after the stored ones", async () => {
    await fast.runFastReply(
      {
        ack: false,
        bot,
        messageId: ids[0],
        model: gated(Promise.resolve(), () => undefined, reply("done")),
        text: "hi",
      },
      () => undefined
    );
    const escalated = await fast.runFastReply(
      {
        ack: false,
        bot,
        messageId: ids[1],
        model: gated(Promise.resolve(), () => undefined, [escalate]),
        text: "open my mail",
      },
      () => undefined
    );
    expect(escalated.escalated).toBe(true);
    expect(await query("SELECT * FROM fast_slot_reservations")).toHaveLength(0);
    // Its message stays pending for the normal path; it wrote no events.
    expect(
      await query(`SELECT status FROM messages WHERE id = '${ids[1]}'`)
    ).toEqual([{ status: "pending" }]);
    expect(await query("SELECT * FROM events")).toHaveLength(4);
    const next = await slots.reserveFastSlot(sessionId, ids[2]);
    expect(next).toEqual({ index: FAST_INDEX_BASE + 4, line: 7 });
  });

  it("reserves distinct slots when allocations interleave on the same index", async () => {
    const reserved = await Promise.all(
      ids.map((id) => slots.reserveFastSlot(sessionId, id))
    );
    expect(new Set(reserved.map((s) => s.index)).size).toBe(3);
  });

  it("keeps an ack's slot until persistAck consumes it", async () => {
    const result = await fast.runFastReply(
      {
        ack: true,
        bot,
        messageId: ids[0],
        model: gated(Promise.resolve(), () => undefined, [
          ...reply("Opening it."),
          escalate,
        ]),
        text: "open my mail",
      },
      () => undefined
    );
    expect(result.ack).toBeDefined();
    expect(await query("SELECT * FROM fast_slot_reservations")).toHaveLength(1);
    // Another exchange meanwhile cannot take the ack's indexes.
    const other = await slots.reserveFastSlot(sessionId, ids[1]);
    expect(other.index).toBe(FAST_INDEX_BASE + 4);
    await fast.persistAck(
      bot,
      result.ack as never,
      ids[0],
      "open my mail",
      "delivery-1"
    );
    expect(await query("SELECT * FROM events")).toHaveLength(3);
  });

  it("an expired reservation is reclaimed, and its stale holder can no longer store", async () => {
    const stale = await slots.reserveFastSlot(sessionId, ids[0]);
    await client.exec(
      "UPDATE fast_slot_reservations SET expires_at = now() - interval '1 second'"
    );
    const fresh = await slots.reserveFastSlot(sessionId, ids[1]);
    expect(fresh).toEqual(stale);
    await expect(
      h
        .db()
        .transaction((tx: never) =>
          slots.consumeFastSlot(tx, sessionId, stale, ids[0])
        )
    ).rejects.toBeInstanceOf(slots.FastSlotLost);
  });
});
