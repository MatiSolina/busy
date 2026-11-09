import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema map to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({ db: vi.fn() }));

vi.mock("./lib/db", () => ({
  bots: schema.bots,
  consultations: schema.consultations,
  cursors: schema.cursors,
  db: h.db,
  events: schema.events,
}));

const botId = "11111111-1111-4111-8111-111111111111";
let client: PGlite;
let save: ReturnType<typeof import("./lib/chat/store").saver>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
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
    CREATE TABLE cursors (
      bot_id uuid NOT NULL,
      next_line integer NOT NULL DEFAULT 0,
      session_id text PRIMARY KEY
    );
  `);
  h.db.mockReturnValue(drizzle(client, { schema }));
  const { saver } = await import("./lib/chat/store");
  save = saver(
    { id: botId, slug: "history-test" } as unknown as Parameters<
      typeof saver
    >[0],
    "session-history-test",
    false,
    "gateway"
  );
});

afterAll(async () => {
  await client.close();
  vi.doUnmock("./lib/db");
});

describe("persisted chat history", () => {
  it("stores NUL-containing stream data and advances the cursor", async () => {
    const at = new Date("2026-11-04T17:00:00.000Z");
    await expect(
      save(
        [
          {
            at,
            data: {
              data: {
                nested: ["before\u0000after"],
                value: "before\u0000after",
              },
              type: "call.settled",
            },
            index: 0,
            line: 1,
            type: "call.settled",
          },
        ],
        2
      )
    ).resolves.toBeUndefined();

    await expect(
      save(
        [
          {
            at,
            data: {
              data: { value: "after the malformed event" },
              type: "content.completed",
            },
            index: 0,
            line: 2,
            type: "content.completed",
          },
        ],
        3
      )
    ).resolves.toBeUndefined();

    // A background retry of the malformed stream line is safe and cannot move
    // the cursor backwards or duplicate the already persisted row.
    await expect(
      save(
        [
          {
            at,
            data: {
              data: {
                nested: ["before\u0000after"],
                value: "before\u0000after",
              },
              type: "call.settled",
            },
            index: 0,
            line: 1,
            type: "call.settled",
          },
        ],
        2
      )
    ).resolves.toBeUndefined();

    const stored = await client.query<{ data: unknown; line: number }>(
      "SELECT data, line FROM events WHERE session_id = $1 ORDER BY line",
      ["session-history-test"]
    );
    expect(stored.rows).toHaveLength(2);
    expect(stored.rows[0]?.line).toBe(1);
    expect(JSON.stringify(stored.rows[0]?.data)).not.toContain("\u0000");
    expect(stored.rows[1]?.line).toBe(2);

    const cursor = await client.query<{ next_line: number }>(
      "SELECT next_line FROM cursors WHERE session_id = $1",
      ["session-history-test"]
    );
    expect(cursor.rows).toEqual([{ next_line: 3 }]);
  });
});
