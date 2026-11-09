import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { relay } from "./lib/chat/sse";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema map to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({ db: vi.fn(), logQuery: vi.fn() }));

vi.mock("./lib/db", () => ({
  bots: schema.bots,
  consultations: schema.consultations,
  cursors: schema.cursors,
  db: h.db,
  events: schema.events,
}));

const fromBotId = "11111111-1111-4111-8111-111111111111";
const peerOneId = "22222222-2222-4222-8222-222222222222";
const peerTwoId = "33333333-3333-4333-8333-333333333333";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// The deployment that holds each child session, as a probe of the consulted bot answers.
const childOwners = new Map<string, string>([
  ["wrun_01ARYZ6S41TSV4RRFFQ69G5FA1", peerOneId],
  ["wrun_01ARYZ6S41TSV4RRFFQ69G5FA2", peerTwoId],
]);
const binding = {
  confirm: async (peer: { id: string }, childSessionId: string) =>
    await Promise.resolve(childOwners.get(childSessionId) === peer.id),
  recordedTarget: async () => await Promise.resolve(null),
};

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
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text,
      status text NOT NULL,
      created_at timestamptz NOT NULL,
      deletion_state text
    );
    CREATE TABLE consultations (
      call_id text UNIQUE NOT NULL,
      child_session_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      from_bot_id uuid NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      parent_session_id text NOT NULL,
      status text NOT NULL DEFAULT 'open',
      to_bot_id uuid
    );
  `);
  h.db.mockReturnValue(
    drizzle(client, { logger: { logQuery: h.logQuery }, schema })
  );
  const { saver } = await import("./lib/chat/store");
  save = saver(
    {
      billing: "gateway",
      id: fromBotId,
      slug: "consultation-test",
    } as Parameters<typeof saver>[0],
    "parent-session",
    true,
    "gateway",
    binding
  );
});

afterAll(async () => {
  await client.close();
  vi.doUnmock("./lib/db");
});

describe("consultation persistence", () => {
  it("looks up peers once per save batch and keeps cursor state atomic", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const query = vi.spyOn(client, "query");
    h.logQuery.mockClear();
    await client.query(
      `INSERT INTO bots (id, status, created_at)
       VALUES ($1, 'ready', '2026-11-04T18:00:00Z'),
              ($2, 'ready', '2026-11-04T18:01:00Z'),
              ($3, 'ready', '2026-11-04T18:02:00Z')`,
      [fromBotId, peerOneId, peerTwoId]
    );
    const at = new Date("2026-11-04T18:00:00.000Z");
    await save(
      [
        {
          at,
          data: {
            data: {
              name: "peer-1",
              owner: { callId: "peer-1" },
              sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA1",
            },
            type: "child.opened",
          },
          index: 0,
          line: 1,
          type: "child.opened",
        },
        {
          at,
          data: {
            data: { callId: "peer-2", outcome: "completed" },
            type: "call.settled",
          },
          index: 1,
          line: 1,
          type: "call.settled",
        },
        {
          at,
          data: {
            data: { callId: "unrelated-tool", outcome: "completed" },
            type: "call.settled",
          },
          index: 2,
          line: 1,
          type: "call.settled",
        },
        {
          at,
          data: {
            data: {
              name: "peer-2",
              owner: { callId: "peer-2" },
              sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA2",
            },
            type: "child.opened",
          },
          index: 0,
          line: 2,
          type: "child.opened",
        },
        {
          at,
          data: {
            data: { callId: "peer-1", outcome: "completed" },
            type: "call.settled",
          },
          index: 0,
          line: 3,
          type: "call.settled",
        },
      ],
      4
    );

    const peerQueries = query.mock.calls.filter(([text]) =>
      String(text).includes('"bots"')
    );
    expect(peerQueries).toHaveLength(1);
    const terminalLookups = h.logQuery.mock.calls.filter(([text]) =>
      String(text).startsWith(
        'select "call_id", "child_session_id", "id" from "consultations"'
      )
    );
    expect(terminalLookups).toHaveLength(1);
    const consultationUpdates = h.logQuery.mock.calls.filter(([text]) =>
      String(text).startsWith('update "consultations"')
    );
    expect(consultationUpdates).toHaveLength(1);
    const stored = await client.query<{
      call_id: string;
      status: string;
      to_bot_id: string | null;
    }>("SELECT call_id, status, to_bot_id FROM consultations ORDER BY call_id");
    expect(stored.rows).toEqual([
      { call_id: "peer-1", status: "done", to_bot_id: peerOneId },
      { call_id: "peer-2", status: "open", to_bot_id: peerTwoId },
    ]);
    const cursor = await client.query<{ next_line: number }>(
      "SELECT next_line FROM cursors WHERE session_id = 'parent-session'"
    );
    expect(cursor.rows).toEqual([{ next_line: 4 }]);
    const ids = await client.query<{ call_id: string; id: string }>(
      "SELECT call_id, id FROM consultations ORDER BY call_id"
    );
    const peerOneConsultationId = ids.rows.find(
      (row) => row.call_id === "peer-1"
    )?.id;
    expect(peerOneConsultationId).toMatch(UUID_V4);
    const operations = info.mock.calls
      .map(
        ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>
      )
      .filter((payload) => payload.flow === "consultation");
    expect(operations).toEqual([
      expect.objectContaining({
        callId: "peer-1",
        childSessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA1",
        flow: "consultation",
        operationId: peerOneConsultationId,
        outcome: "started",
        parentSessionId: "parent-session",
        sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA1",
        stage: "session",
      }),
      expect.objectContaining({
        callId: "peer-2",
        childSessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA2",
        flow: "consultation",
        outcome: "started",
        parentSessionId: "parent-session",
        sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA2",
        stage: "session",
      }),
      expect.objectContaining({
        callId: "peer-1",
        childSessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA1",
        flow: "consultation",
        operationId: peerOneConsultationId,
        outcome: "completed",
        parentSessionId: "parent-session",
        sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA1",
        stage: "terminal",
      }),
    ]);
    expect(JSON.stringify(operations)).not.toContain("replay");
    info.mockRestore();
    query.mockRestore();
  });

  it("settles opaque provider call IDs only in their exact parent session", async () => {
    await client.exec("TRUNCATE events, cursors, consultations, bots");
    await client.query(
      `INSERT INTO bots (id, status, created_at)
       VALUES ($1, 'ready', '2026-11-04T18:00:00Z')`,
      [fromBotId]
    );
    const callId = "chatcmpl-tool-opaque";
    await client.query(
      `INSERT INTO consultations (call_id, child_session_id, from_bot_id, parent_session_id)
       VALUES ($1, 'wrun_01ARYZ6S41TSV4RRFFQ69G5FA3', $2, 'parent-session')`,
      [callId, fromBotId]
    );
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const otherSave = (await import("./lib/chat/store")).saver(
      {
        billing: "gateway",
        id: fromBotId,
        slug: "consultation-test",
      } as Parameters<typeof import("./lib/chat/store").saver>[0],
      "other-parent",
      true,
      "gateway"
    );
    const terminal = [
      {
        at: new Date("2026-11-04T18:00:00.000Z"),
        data: {
          data: { callId, outcome: "completed" },
          type: "call.settled",
        },
        index: 0,
        line: 1,
        type: "call.settled",
      },
    ];
    await otherSave(terminal, 2);
    expect(
      (
        await client.query<{ status: string }>(
          "SELECT status FROM consultations WHERE call_id = $1",
          [callId]
        )
      ).rows[0]
    ).toEqual({ status: "open" });
    await save(terminal, 2);
    expect(
      (
        await client.query<{ status: string }>(
          "SELECT status FROM consultations WHERE call_id = $1",
          [callId]
        )
      ).rows[0]
    ).toEqual({ status: "done" });
    const records = info.mock.calls
      .map(
        ([payload]) => JSON.parse(String(payload)) as Record<string, unknown>
      )
      .filter((payload) => payload.flow === "consultation");
    expect(records).toEqual([
      expect.objectContaining({
        callId,
        childSessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA3",
        outcome: "completed",
        parentSessionId: "parent-session",
        sessionId: "wrun_01ARYZ6S41TSV4RRFFQ69G5FA3",
        stage: "terminal",
      }),
    ]);
    expect(records[0]?.operationId).toMatch(UUID_V4);
    info.mockRestore();
  });

  it("stops the cursor after a failed batch and replays safely", async () => {
    await client.exec("TRUNCATE events, cursors, consultations, bots");
    const rows = Array.from({ length: 300 }, (_, offset) => ({
      line: offset + 1,
      record: {
        facts: [
          {
            data: { value: `replay-${offset + 1}` },
            type: "content.completed",
          },
        ],
      },
    }));
    const stream = async function* (from: number, to: number) {
      await Promise.resolve();
      for (const row of rows.slice(from - 1, to)) {
        yield row;
      }
    };
    let calls = 0;
    const flakySave = async (
      batch: Parameters<typeof save>[0],
      nextLine: number
    ) => {
      calls += 1;
      if (calls === 2) {
        throw new Error("synthetic persistence outage");
      }
      await save(batch, nextLine);
    };

    await expect(
      relay(stream(1, 301), flakySave, vi.fn(), () => false)
    ).resolves.toBe(false);
    const partial = await client.query<{ count: string; next_line: number }>(
      `SELECT
         (SELECT count(*)::text FROM events WHERE session_id = 'parent-session') AS count,
         (SELECT next_line FROM cursors WHERE session_id = 'parent-session') AS next_line`
    );
    expect(partial.rows[0]).toEqual({ count: "256", next_line: 257 });

    await expect(
      relay(stream(257, 301), save, vi.fn(), () => false)
    ).resolves.toBe(true);
    const final = await client.query<{ count: string; next_line: number }>(
      `SELECT
         (SELECT count(*)::text FROM events WHERE session_id = 'parent-session') AS count,
         (SELECT next_line FROM cursors WHERE session_id = 'parent-session') AS next_line`
    );
    expect(final.rows[0]).toEqual({ count: "300", next_line: 301 });
  });

  it("chunks ten thousand facts from one atomic record within one transaction", async () => {
    await client.exec("TRUNCATE events, cursors, consultations, bots");
    const facts = Array.from({ length: 10_000 }, (_, index) => ({
      data: { value: `fact-${index}` },
      type: "content.completed",
    }));

    async function* stream() {
      await Promise.resolve();
      yield { line: 1, record: { facts } };
    }

    await expect(relay(stream(), save, vi.fn(), () => false)).resolves.toBe(
      true
    );
    const result = await client.query<{ count: string; next_line: number }>(
      `SELECT
         (SELECT count(*)::text FROM events WHERE session_id = 'parent-session') AS count,
         (SELECT next_line FROM cursors WHERE session_id = 'parent-session') AS next_line`
    );
    expect(result.rows[0]).toEqual({ count: "10000", next_line: 2 });
  });
});
