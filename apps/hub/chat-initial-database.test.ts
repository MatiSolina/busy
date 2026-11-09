import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deployMigration } from "./lib/bots/test-helpers";
import { bots, consultations, events, messages } from "./lib/db/schema";

let client: PGlite;
let initial: typeof import("./lib/chat/initial");
let send: typeof import("./lib/chat/send");
let queries: string[] = [];
const MICROSECOND_CURSOR = /\.0006(?:-03|\+00)$/u;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (
      id uuid PRIMARY KEY, slug text, name text, description text DEFAULT '',
      avatar text, billing text DEFAULT 'gateway', created_at timestamptz DEFAULT now(),
      deployment_id text, error text, fast boolean DEFAULT false,
      history_pending boolean DEFAULT false, instructions text DEFAULT '',
      deletion_state text, deletion_token uuid, deletion_requested_at timestamptz,
      deletion_attempts integer NOT NULL DEFAULT 0, deletion_next_attempt_at timestamptz,
      deletion_last_error text, deletion_project_id text,
      live_until timestamptz, model text DEFAULT 'test', session_id text,
      status text DEFAULT 'ready', updated_at timestamptz DEFAULT now(), url text
    );
    CREATE TABLE events (
      at timestamptz NOT NULL, bot_id uuid, data jsonb, index integer,
      line integer, session_id text, type text,
      PRIMARY KEY (session_id, line, index)
    );
    CREATE TABLE messages (bot_id uuid, delivery_id text);
    CREATE TABLE consultations (id uuid, call_id text, from_bot_id uuid, to_bot_id uuid);
    INSERT INTO bots (id, slug, name, session_id) VALUES
      ('11111111-1111-4111-8111-111111111111', 'alpha', 'Alpha', 'current');
    INSERT INTO bots (id, slug, name, created_at) VALUES
      ('22222222-2222-4222-8222-222222222222', 'beta', 'Beta', now() + interval '1 second');
    INSERT INTO messages VALUES
      ('11111111-1111-4111-8111-111111111111', 'old-delivery');
    INSERT INTO events VALUES
      ('2026-01-01', '11111111-1111-4111-8111-111111111111',
       '{"type":"delivery.consumed","data":{"deliveryId":"old-delivery"}}',
       0, 0, 'old', 'delivery.consumed'),
      ('2026-01-02', '11111111-1111-4111-8111-111111111111',
       '{"type":"delivery.consumed","data":{"deliveryId":"peer-delivery"}}',
       0, 0, 'consultation', 'delivery.consumed'),
      ('2026-01-03', '11111111-1111-4111-8111-111111111111',
       '{"type":"turn.settled","data":{"turnId":"t","outcome":"completed"}}',
       0, 99, 'current', 'turn.settled');
  `);
  // Bots columns added by later SQL migrations (bots predates drizzle/).
  await client.exec(deployMigration());
  const database = drizzle(client, {
    logger: { logQuery: (query) => queries.push(query) },
  });
  vi.doMock("@/lib/db", () => ({
    bots,
    consultations,
    db: () => database,
    events,
    messages,
  }));
  initial = await import("./lib/chat/initial");
  send = await import("./lib/chat/send");
});

afterAll(async () => {
  vi.doUnmock("@/lib/db");
  await client.close();
});

describe("chat startup history budget", () => {
  it("sends full message bodies for the selected conversation and compact status rows for the others", async () => {
    await client.exec(
      `INSERT INTO events VALUES ('2026-01-03', '11111111-1111-4111-8111-111111111111', '{"type":"content.completed","data":{"kind":"text","value":"Large previous reply"}}', 0, 50, 'current', 'content.completed')`
    );
    try {
      const [background] = await initial.initialData("beta");
      expect(background?.snapshotLoaded).toBe(false);
      expect(background?.rows.map((r) => r.line)).toEqual([99]);
      const [selected] = await initial.initialData("alpha");
      expect(selected?.snapshotLoaded).toBe(true);
      expect(selected?.rows.map((r) => r.line)).toEqual([50, 99]);
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id = 'current' AND line = 50"
      );
    }
  });

  it("only offers earlier conversations to bots with an archived session", async () => {
    const empty = "88888888-8888-4888-8888-888888888888";
    const fast = "99999999-9999-4999-8999-999999999999";
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES
        ('${empty}', 'fresh-empty', 'Fresh Empty', 'fresh-empty'),
        ('${fast}', 'fresh-fast', 'Fresh Fast', 'fresh-fast');
      INSERT INTO messages VALUES ('${fast}', 'fast-delivery');
      INSERT INTO events VALUES
        (now(), '${fast}', '{"type":"delivery.consumed","data":{"deliveryId":"fast-delivery"}}', 1000000000, -1, 'fresh-fast', 'delivery.consumed'),
        (now(), '${fast}', '{"type":"content.completed","data":{"kind":"text","value":"hi"}}', 1000000001, -1, 'fresh-fast', 'content.completed');
    `);
    try {
      for (const slug of ["beta", "fresh-empty", "fresh-fast"]) {
        // biome-ignore lint/performance/noAwaitInLoops: Each selection is a separate startup.
        const selected = (await initial.initialData(slug)).find(
          (b) => b.slug === slug
        );
        expect(selected).toMatchObject({
          historyHasMore: false,
          pastLoaded: true,
        });
      }
      const alpha = (await initial.initialData("alpha")).find(
        (b) => b.slug === "alpha"
      );
      expect(alpha?.pastLoaded).toBe(false);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE bot_id IN ('${empty}', '${fast}'); DELETE FROM messages WHERE bot_id = '${fast}'; DELETE FROM bots WHERE id IN ('${empty}', '${fast}')`
      );
    }
  });

  it("retains the bounded initial window and line/index order in the batch query", async () => {
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('33333333-3333-4333-8333-333333333333', 'gamma', 'Gamma', 'large');
      INSERT INTO events SELECT now(), '33333333-3333-4333-8333-333333333333'::uuid,
        '{"type":"turn.started","data":{}}'::jsonb, n % 2, n / 2, 'large', 'turn.started'
        FROM generate_series(0, 599) n;
    `);
    try {
      const gamma = (await initial.initialData("gamma")).find(
        (b) => b.slug === "gamma"
      );
      expect(gamma?.rows).toHaveLength(120);
      expect(gamma?.rows[0]).toMatchObject({ index: 0, line: 240 });
      expect(gamma?.rows.at(-1)).toMatchObject({ index: 1, line: 299 });
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id = 'large'; DELETE FROM bots WHERE slug = 'gamma'"
      );
    }
  });
  it("does not advertise an older page when the session ends exactly at the window", async () => {
    const botId = "66666666-6666-4666-8666-666666666666";
    const sessionId = "exact-window";
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('${botId}', 'exact-window', 'Exact Window', '${sessionId}');
      INSERT INTO events SELECT now(), '${botId}'::uuid,
        '{"type":"turn.settled","data":{}}'::jsonb,
        0, n, '${sessionId}', 'turn.settled'
        FROM generate_series(0, 119) n;
    `);
    try {
      const exact = (await initial.initialData("exact-window")).find(
        (b) => b.slug === "exact-window"
      );
      expect(exact?.rows).toHaveLength(120);
      expect(exact?.historyCursor).toBeNull();
      expect(exact?.historyHasMore).toBe(false);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM bots WHERE slug = 'exact-window'`
      );
    }
  });
  it("retains turn and delivery boundaries for an active turn larger than the initial window", async () => {
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('44444444-4444-4444-8444-444444444444', 'active-large', 'Active Large', 'active-large');
      INSERT INTO events VALUES
        ('2026-01-10', '44444444-4444-4444-8444-444444444444', '{"type":"delivery.consumed","data":{"deliveryId":"active-delivery","parts":[{"kind":"text","text":"Keep this prompt"}]},"scope":{"turnId":"active-turn"}}', 0, 0, 'active-large', 'delivery.consumed'),
        ('2026-01-10', '44444444-4444-4444-8444-444444444444', '{"type":"turn.started","data":{"turnId":"active-turn"}}', 0, 1, 'active-large', 'turn.started');
      INSERT INTO events SELECT now(), '44444444-4444-4444-8444-444444444444'::uuid,
        '{"type":"call.settled","data":{"callId":"tool"}}'::jsonb, 0, n, 'active-large', 'call.settled'
        FROM generate_series(2, 650) n;
    `);
    try {
      const active = (await initial.initialData("active-large")).find(
        (b) => b.slug === "active-large"
      );
      expect(active?.rows).toHaveLength(122);
      expect(active?.rows[0]).toMatchObject({
        line: 0,
        type: "delivery.consumed",
      });
      expect(active?.rows[1]).toMatchObject({ line: 1, type: "turn.started" });
      expect(active?.historyCursor).toEqual({ index: 0, line: 531 });
      expect(active?.historyHasMore).toBe(true);
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id = 'active-large'; DELETE FROM bots WHERE slug = 'active-large'"
      );
    }
  });
  it("treats a task whose starting call settled as finished, without a task.ended", async () => {
    // eve ends agent tasks with the call.settled of the call that started them; task.ended never came.
    const botId = "88888888-8888-4888-8888-888888888888";
    const sessionId = "settled-task";
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('${botId}', 'settled-task', 'Settled Task', '${sessionId}');
      INSERT INTO events VALUES
        ('2026-01-10', '${botId}', '{"type":"task.started","data":{"taskId":"done-task","startedBy":{"callId":"done-call"}}}', 0, 0, '${sessionId}', 'task.started'),
        ('2026-01-10', '${botId}', '{"type":"call.settled","data":{"callId":"done-call","outcome":"completed"}}', 0, 1, '${sessionId}', 'call.settled'),
        ('2026-01-10', '${botId}', '{"type":"task.started","data":{"taskId":"open-task","startedBy":{"callId":"open-call"}}}', 0, 2, '${sessionId}', 'task.started');
      INSERT INTO events SELECT now(), '${botId}'::uuid,
        '{"type":"content.completed","data":{"kind":"text","phase":"reply","value":"x"}}'::jsonb,
        0, n, '${sessionId}', 'content.completed'
        FROM generate_series(3, 300) n;
    `);
    try {
      const active = (await initial.initialData("settled-task")).find(
        (b) => b.slug === "settled-task"
      );
      const tasks = active?.rows.filter((r) => r.type === "task.started");
      expect(tasks?.map((r) => r.line)).toEqual([2]);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM bots WHERE slug = 'settled-task'`
      );
    }
  });
  it("keeps the line watermark separate from a same-line 120-row tail", async () => {
    const botId = "77777777-7777-4777-8777-777777777777";
    const sessionId = "same-line-tail";
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('${botId}', 'same-line-tail', 'Same Line Tail', '${sessionId}');
      INSERT INTO events SELECT now(), '${botId}'::uuid,
        '{"type":"content.completed","data":{"kind":"text","phase":"reply","value":"chunk"}}'::jsonb,
        n, 42, '${sessionId}', 'content.completed'
        FROM generate_series(0, 149) n;
    `);
    try {
      const active = (await initial.initialData("same-line-tail")).find(
        (b) => b.slug === "same-line-tail"
      );
      const page = await initial.recentRowsPage(sessionId, null, 120);
      const replay = await send.persistedEvents(sessionId, 41);
      const resetReplay = await send.persistedEvents(sessionId, -1);
      expect(active?.rows).toHaveLength(120);
      expect(active?.rows[0]).toMatchObject({ index: 30, line: 42 });
      expect(active?.resumeAfter).toBe(42);
      expect(active?.historyCursor).toEqual({ index: 30, line: 42 });
      expect(active?.historyHasMore).toBe(true);
      expect(page.resumeAfter).toBe(42);
      expect(page.nextCursor).toEqual({ index: 30, line: 42 });
      expect(replay).toHaveLength(150);
      expect(resetReplay).toHaveLength(150);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM bots WHERE slug = 'same-line-tail'`
      );
    }
  });
  it("keeps every unresolved interaction and its latest response outside the tail", async () => {
    const botId = "55555555-5555-4555-8555-555555555555";
    const sessionId = "active-interactions";
    const interactionRows = Array.from({ length: 70 }, (_, index) => {
      const interactionId = `approval-${index}`;
      const fact = {
        data: {
          interactionId,
          request: {
            kind: "approval",
            prompt: `Approve ${index}`,
          },
        },
        type: "interaction.opened",
      };
      return `('2026-01-11', '${botId}', '${JSON.stringify(fact)}', 0, ${index + 2}, '${sessionId}', 'interaction.opened')`;
    });
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('${botId}', 'active-interactions', 'Active Interactions', '${sessionId}');
      INSERT INTO events VALUES
        ('2026-01-11', '${botId}', '{"type":"delivery.consumed","data":{"deliveryId":"active-delivery","turnId":"active-turn","parts":[{"kind":"text","text":"Keep this prompt"}]}}', 0, 0, '${sessionId}', 'delivery.consumed'),
        ('2026-01-11', '${botId}', '{"type":"turn.started","data":{"turnId":"active-turn"}}', 0, 1, '${sessionId}', 'turn.started'),
        ${interactionRows.join(",\n        ")},
        ('2026-01-11', '${botId}', '{"type":"interaction.settled","data":{"interactionId":"approval-0","outcome":"accepted"}}', 0, 80, '${sessionId}', 'interaction.settled'),
        ('2026-01-11', '${botId}', '{"type":"response.submitted","data":{"interactionId":"approval-1","responseId":"response-1","optionId":"approve"}}', 0, 81, '${sessionId}', 'response.submitted'),
        ('2026-01-11', '${botId}', '{"type":"response.admitted","data":{"responseId":"response-1"}}', 0, 82, '${sessionId}', 'response.admitted'),
        ('2026-01-11', '${botId}', '{"type":"response.settled","data":{"responseId":"response-1","outcome":"applied"}}', 0, 83, '${sessionId}', 'response.settled');
      INSERT INTO events SELECT now(), '${botId}'::uuid,
        '{"type":"call.settled","data":{"callId":"tail-call"}}'::jsonb,
        0, n, '${sessionId}', 'call.settled'
        FROM generate_series(100, 699) n;
    `);
    try {
      const active = (await initial.initialData("active-interactions")).find(
        (b) => b.slug === "active-interactions"
      );
      const page = await initial.recentRowsPage(sessionId, null, 120);
      const openIds = new Set(
        active?.rows
          .filter((row) => row.type === "interaction.opened")
          .map((row) => String(row.data.data.interactionId))
      );
      expect(openIds.size).toBe(69);
      expect(openIds).toContain("approval-69");
      expect(openIds).not.toContain("approval-0");
      expect(active?.rows).toContainEqual(
        expect.objectContaining({ line: 0, type: "delivery.consumed" })
      );
      expect(active?.rows).toContainEqual(
        expect.objectContaining({ line: 1, type: "turn.started" })
      );
      expect(active?.rows).toContainEqual(
        expect.objectContaining({ line: 81, type: "response.submitted" })
      );
      expect(page.rows).toEqual(expect.arrayContaining(active?.rows ?? []));
      expect(page.nextCursor?.line).toBe(580);
      expect(page.hasMore).toBe(true);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM bots WHERE slug = 'active-interactions'`
      );
    }
  });
  it("replays the latest 120 complete lines after a reset", async () => {
    const botId = "88888888-8888-4888-8888-888888888888";
    const sessionId = "reset-lines";
    await client.exec(`
      INSERT INTO bots (id, slug, name, session_id) VALUES ('${botId}', 'reset-lines', 'Reset Lines', '${sessionId}');
      INSERT INTO events VALUES
        (now(), '${botId}', '{"type":"delivery.admitted","data":{"deliveryId":"old-delivery"}}', 0, 0, '${sessionId}', 'delivery.admitted'),
        (now(), '${botId}', '{"type":"delivery.settled","data":{"deliveryId":"old-delivery"}}', 0, 1, '${sessionId}', 'delivery.settled');
      INSERT INTO events SELECT now(), '${botId}'::uuid,
        '{"type":"call.settled","data":{"callId":"call"}}'::jsonb,
        0, n, '${sessionId}', 'call.settled'
        FROM generate_series(2, 198) n;
      INSERT INTO events VALUES
        (now(), '${botId}', '{"type":"call.settled","data":{"callId":"latest-0"}}', 0, 199, '${sessionId}', 'call.settled'),
        (now(), '${botId}', '{"type":"call.settled","data":{"callId":"latest-1"}}', 1, 199, '${sessionId}', 'call.settled'),
        (now(), '${botId}', '{"type":"call.settled","data":{"callId":"latest-2"}}', 2, 199, '${sessionId}', 'call.settled');
    `);
    try {
      const replay = await send.persistedEvents(sessionId, -1);
      const tail = await send.persistedTailEvents(sessionId);
      expect(replay[0]).toMatchObject({ index: 0, line: 0 });
      expect(replay[1]).toMatchObject({ line: 1, type: "delivery.settled" });
      expect(replay).toHaveLength(202);
      expect(tail[0]).toMatchObject({ index: 0, line: 80 });
      expect(tail.at(-1)).toMatchObject({ index: 2, line: 199 });
      expect(tail).toHaveLength(122);
      expect(new Set(tail.map((row) => row.line)).size).toBe(120);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM bots WHERE slug = 'reset-lines'`
      );
    }
  });
  it("uses a constant query budget as the bot directory grows", async () => {
    queries = [];
    const result = await initial.initialData();
    expect(result).toHaveLength(2);
    expect(result[1]?.rows).toEqual([]);
    expect(queries.length).toBeLessThanOrEqual(3);
  });
  it("retrieves archived user sessions on demand without including consultation sessions", async () => {
    const result = await initial.pastSessions(
      "11111111-1111-4111-8111-111111111111",
      "current"
    );
    expect(result.map((session) => session.sessionId)).toEqual(["old"]);
    expect(result[0]?.rows).toHaveLength(1);
  });
  it("pages archived sessions by a stable newest-first cursor and preserves chronological output", async () => {
    await client.exec(`
      INSERT INTO messages VALUES
        ('11111111-1111-4111-8111-111111111111', 'old-1'),
        ('11111111-1111-4111-8111-111111111111', 'old-2'),
        ('11111111-1111-4111-8111-111111111111', 'old-3'),
        ('11111111-1111-4111-8111-111111111111', 'old-4'),
        ('11111111-1111-4111-8111-111111111111', 'old-5');
      INSERT INTO events VALUES
        ('2026-01-04', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"old-1"}}', 0, 0, 'old-1', 'delivery.consumed'),
        ('2026-01-05', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"old-2"}}', 0, 0, 'old-2', 'delivery.consumed'),
        ('2026-01-06', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"old-3"}}', 0, 0, 'old-3', 'delivery.consumed'),
        ('2026-01-07', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"old-4"}}', 0, 0, 'old-4', 'delivery.consumed'),
        ('2026-01-08', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"old-5"}}', 0, 0, 'old-5', 'delivery.consumed');
    `);
    try {
      const result = await initial.pastSessions(
        "11111111-1111-4111-8111-111111111111",
        "current"
      );
      expect(result.map((session) => session.sessionId)).toEqual([
        "old",
        "old-1",
        "old-2",
        "old-3",
        "old-4",
        "old-5",
      ]);
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id IN ('old-1', 'old-2', 'old-3', 'old-4', 'old-5'); DELETE FROM messages WHERE delivery_id LIKE 'old-_'"
      );
    }
  });
  it("loads only one bounded archived page instead of all session bodies", async () => {
    const values = Array.from({ length: 64 }, (_, index) => {
      const suffix = String(index + 10).padStart(2, "0");
      const id = `archived-${suffix}`;
      const date = new Date(Date.UTC(2026, 1, index + 1))
        .toISOString()
        .slice(0, 10);
      return `
        INSERT INTO messages VALUES ('11111111-1111-4111-8111-111111111111', 'delivery-${id}');
        INSERT INTO events VALUES ('${date}', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"delivery-${id}"}}', 0, 0, '${id}', 'delivery.consumed');`;
    }).join("\n");
    await client.exec(values);
    try {
      queries = [];
      const page = await initial.pastSessionsPage(
        "11111111-1111-4111-8111-111111111111",
        "current",
        null
      );
      expect(page.past).toHaveLength(5);
      expect(page.nextCursor).toBeTruthy();
      expect(page.past.every((session) => session.rows.length === 1)).toBe(
        true
      );
      // One grouped session query plus a watermark and bounded tail query per session.
      expect(queries.length).toBeLessThanOrEqual(1 + 2 * 5);
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id LIKE 'archived-%'; DELETE FROM messages WHERE delivery_id LIKE 'delivery-archived-%'"
      );
    }
  });
  it("pages facts inside an archived session without losing its oldest row", async () => {
    const sessionId = "archive-long";
    await client.exec(`
      INSERT INTO messages VALUES ('11111111-1111-4111-8111-111111111111', 'archive-long-delivery');
      INSERT INTO events VALUES
        ('2026-02-01', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"archive-long-delivery"}}', 0, 0, '${sessionId}', 'delivery.consumed');
      INSERT INTO events SELECT now(), '11111111-1111-4111-8111-111111111111'::uuid,
        '{"type":"content.completed","data":{"kind":"text","value":"archive"}}'::jsonb,
        0, n, '${sessionId}', 'content.completed'
        FROM generate_series(1, 400) n;
    `);
    try {
      const first = await initial.recentRowsPage(sessionId, null, 400);
      expect(first.rows).toHaveLength(400);
      expect(first.rows[0]?.line).toBe(1);
      expect(first.nextCursor?.line).toBe(1);
      expect(first.hasMore).toBe(true);
      const second = await initial.recentRowsPage(
        sessionId,
        first.nextCursor,
        400
      );
      expect(second.rows.map((row) => row.line)).toEqual([0]);
      expect(second.hasMore).toBe(false);
    } finally {
      await client.exec(
        `DELETE FROM events WHERE session_id = '${sessionId}'; DELETE FROM messages WHERE delivery_id = 'archive-long-delivery'`
      );
    }
  });
  it("keeps microsecond cursor precision across equal-time page boundaries", async () => {
    const sessions = [
      ["tie-a", "2026-03-01 00:00:00.000700+00"],
      ["tie-b", "2026-03-01 00:00:00.000600+00"],
      ["tie-c", "2026-03-01 00:00:00.000500+00"],
      ["tie-d", "2026-03-01 00:00:00.000400+00"],
    ] as const;
    await client.exec(
      sessions
        .map(
          ([sessionId, date]) => `
            INSERT INTO messages VALUES ('11111111-1111-4111-8111-111111111111', 'delivery-${sessionId}');
            INSERT INTO events VALUES ('${date}', '11111111-1111-4111-8111-111111111111', '{"type":"delivery.consumed","data":{"deliveryId":"delivery-${sessionId}"}}', 0, 0, '${sessionId}', 'delivery.consumed');`
        )
        .join("\n")
    );
    try {
      const first = await initial.pastSessionsPage(
        "11111111-1111-4111-8111-111111111111",
        "current",
        null,
        2
      );
      expect(first.nextCursor?.startedAt).toMatch(MICROSECOND_CURSOR);
      const second = await initial.pastSessionsPage(
        "11111111-1111-4111-8111-111111111111",
        "current",
        first.nextCursor,
        2
      );
      expect(
        [...second.past, ...first.past].map((session) => session.sessionId)
      ).toEqual(["tie-d", "tie-c", "tie-b", "tie-a"]);
    } finally {
      await client.exec(
        "DELETE FROM events WHERE session_id LIKE 'tie-%'; DELETE FROM messages WHERE delivery_id LIKE 'delivery-tie-%'"
      );
    }
  });
  it("rejects malformed cursors instead of replaying the first page", () => {
    expect(initial.parsePastCursor("not-json")).toBeNull();
    expect(
      initial.parsePastCursor(JSON.stringify({ sessionId: "x" }))
    ).toBeNull();
    expect(initial.parseHistoryCursor("not-json")).toBeNull();
    expect(
      initial.parseHistoryCursor(JSON.stringify({ index: 0, line: 12 }))
    ).toEqual({ index: 0, line: 12 });
  });
  it("loads current rows and cursor without serializing archived conversations", async () => {
    const result = await initial.initialData();
    expect(result[0]?.rows).toEqual([expect.objectContaining({ line: 99 })]);
    expect(result[0]?.past).toEqual([]);
    expect(result[0]?.pastLoaded).toBe(false);
  });
});
