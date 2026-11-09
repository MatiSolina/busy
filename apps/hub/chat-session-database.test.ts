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
import { botsMigrations } from "./lib/bots/test-helpers";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  database: null as unknown,
  endSession: vi.fn(),
  getBot: vi.fn(),
  sendMessage: vi.fn(),
  sleep: vi.fn(),
  stop: vi.fn(),
  syncBotSession: vi.fn(),
}));

vi.mock("./lib/db", () => ({ ...schema, db: () => h.database }));
vi.mock("./lib/eve/client", () => ({
  createSession: h.createSession,
  endSession: h.endSession,
  sendMessage: h.sendMessage,
}));
vi.mock("./lib/live", () => ({
  KEEP_ON_MS: 600_000,
  stopComputerObserved: h.stop,
}));
vi.mock("./lib/chat/store", () => ({
  botCall: (bot: string) => ({
    token: async () => "token",
    url: `https://${bot}.bots.test`,
  }),
  syncBotSession: h.syncBotSession,
  syncConsultation: vi.fn(),
}));
vi.mock("./lib/firesides/store", () => ({ firesideContext: async () => [] }));
vi.mock("./lib/operation-observability", () => ({ observeOperation: vi.fn() }));
vi.mock("./lib/bots/service", () => ({ getBot: h.getBot }));
vi.mock("workflow", () => ({ sleep: h.sleep }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));
vi.mock("./lib/files", () => ({ fileForMessage: vi.fn() }));
vi.mock("./lib/library-objects", () => ({ linkFileProvenance: vi.fn() }));
vi.mock("./lib/keep-on", () => ({ keepOn: vi.fn() }));
vi.mock("./lib/chat/fast-reply", () => ({ pendingFastExchanges: vi.fn() }));

const { acceptMessage, reconcileMessages } = await import(
  "./lib/chat/attempts"
);
const { deliverMessage, markMessageFailed } = await import(
  "./lib/chat/deliver"
);
const {
  failGoneAttempt,
  openSession,
  recentHistory,
  resendPinned,
  sendToBot,
  UnknownDeliveryError,
} = await import("./lib/chat/send");
const { endOrphanSessions, replaceMainSession } = await import(
  "./lib/chat/session"
);
const { syncTurnWorkflow } = await import("./workflows/sync-turn");

const botId = "11111111-1111-4111-8111-111111111111";
const slug = "ana";
const messageId = "22222222-2222-4222-8222-222222222222";
const call = { token: async () => "token", url: "https://ana.bots.test" };
const STRANDED = 'eve send failed: 410 {"code":"session_stranded"}';

let client: PGlite;

/** A promise the test resolves: forces one writer to wait at an exact point. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const wait = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

async function one<T>(query: string, params: unknown[] = []) {
  return (await client.query<T>(query, params)).rows[0];
}

async function botRow() {
  return await one<{ history_pending: boolean; session_id: string | null }>(
    "SELECT session_id, history_pending FROM bots WHERE id = $1",
    [botId]
  );
}

async function readBot(): Promise<schema.BotRow> {
  const db = h.database as ReturnType<typeof drizzle<typeof schema>>;
  const [row] = await db.select().from(schema.bots);
  return row as schema.BotRow;
}

const message = (text = "Hola", id = messageId) => ({ files: [], id, text });
const LOST_ACK = "Connection ended.";

/** sendToBot only delivers stored messages (#195 checks ownership before the POST). */
async function stored(id = messageId, text = "Hola") {
  await client.query(
    "INSERT INTO messages (id, bot_id, text) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [id, botId, text]
  );
}

async function attemptRow(id = messageId) {
  return await one<{ session_id: string | null; state: string }>(
    "SELECT session_id, state FROM message_delivery_attempts WHERE message_id = $1",
    [id]
  );
}

/**
 * Lets the second opener read "no session", find the reservation taken and poll once (the helper
 * polls every 250 ms) while the first is still inside createSession.
 */
async function waitedForReservation() {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Bot',
      avatar text,
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'model/example',
      billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ready',
      deployment_id text,
      url text,
      session_id text,
      live_until timestamptz,
      history_pending boolean NOT NULL DEFAULT false,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      text text NOT NULL,
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      client_context jsonb,
      payload_hash text,
      delivery_id text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      selected_skills jsonb NOT NULL DEFAULT '[]'
    );
    CREATE TABLE events (
      session_id text NOT NULL,
      line integer NOT NULL,
      index integer NOT NULL,
      bot_id uuid NOT NULL,
      type text NOT NULL,
      data jsonb NOT NULL,
      at timestamptz NOT NULL,
      PRIMARY KEY (session_id, line, index)
    );
    CREATE TABLE consultations (
      id uuid PRIMARY KEY,
      call_id text,
      child_session_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      from_bot_id uuid,
      parent_session_id text,
      status text NOT NULL DEFAULT 'open',
      to_bot_id uuid
    );
  `);
  await client.exec(botsMigrations());
  // The real migration, applied twice: it must be idempotent.
  const migration = readFileSync(
    fileURLToPath(
      new URL("./drizzle/0026_session_bindings.sql", import.meta.url)
    ),
    "utf8"
  );
  await client.exec(migration);
  await client.exec(migration);
  // #195's delivery identity and recovery tables (in production with 0026).
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0025_session_recovery.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  h.database = drizzle(client, { schema });
});

beforeEach(async () => {
  vi.resetAllMocks();
  h.endSession.mockResolvedValue(true);
  h.stop.mockResolvedValue(undefined);
  h.sleep.mockResolvedValue(undefined);
  h.syncBotSession.mockResolvedValue(undefined);
  await client.exec(
    "DELETE FROM session_recoveries; DELETE FROM message_delivery_attempts; DELETE FROM bot_session_openings; DELETE FROM bot_sessions; DELETE FROM bots; DELETE FROM messages; DELETE FROM events;"
  );
  await client.query("INSERT INTO bots (id, slug) VALUES ($1, $2)", [
    botId,
    slug,
  ]);
});

afterAll(async () => {
  await client.close();
});

describe("migration 0026", () => {
  it("backfills current main sessions and the admitting session of accepted messages", async () => {
    const fresh = new PGlite();
    await fresh.exec(`
      CREATE TABLE bots (id uuid PRIMARY KEY, session_id text);
      CREATE TABLE messages (id uuid PRIMARY KEY, bot_id uuid NOT NULL,
        delivery_id text, status text NOT NULL DEFAULT 'pending');
      CREATE TABLE events (session_id text NOT NULL, line integer NOT NULL,
        index integer NOT NULL, bot_id uuid NOT NULL, type text NOT NULL,
        data jsonb NOT NULL, at timestamptz NOT NULL);
      INSERT INTO bots VALUES ('${botId}', 'current');
      INSERT INTO messages VALUES ('${messageId}', '${botId}', 'd-1', 'accepted');
      INSERT INTO events VALUES ('archived', 3, 0, '${botId}', 'delivery.admitted',
        '{"type":"delivery.admitted","data":{"deliveryId":"d-1"}}', now());
    `);
    await fresh.exec(
      readFileSync(
        fileURLToPath(
          new URL("./drizzle/0026_session_bindings.sql", import.meta.url)
        ),
        "utf8"
      )
    );
    expect(
      (await fresh.query("SELECT session_id, generation FROM bot_sessions"))
        .rows
    ).toEqual([{ generation: 0, session_id: "current" }]);
    expect(
      (await fresh.query("SELECT session_id, attempt FROM messages")).rows
    ).toEqual([{ attempt: 0, session_id: "archived" }]);
    await expect(
      fresh.query(
        `UPDATE messages SET failure = 'made-up' WHERE id = '${messageId}'`
      )
    ).rejects.toThrow("messages_failure_check");
    await fresh.close();
  });
});

describe("main session opening (H-02, N-06)", () => {
  it("Live and a first message that both read no session end with one canonical session", async () => {
    // The message replaces "no session" through #195's recovery (its own reservation); Live through
    // the main-session opening. Both install with a compare-and-set: one wins, the other adopts it
    // and its own session is recorded and ended.
    const eve = gate<string>();
    h.createSession.mockImplementation((_call: unknown, operationId: string) =>
      operationId.startsWith("busy:recovery:")
        ? Promise.resolve("message-session")
        : eve.wait
    );
    h.sendMessage.mockResolvedValue({ deliveryId: "delivery-1" });
    await stored();
    const stale = await readBot();
    expect(stale.sessionId).toBeNull();

    const opening = openSession(stale);
    await vi.waitFor(() => expect(h.createSession).toHaveBeenCalledTimes(1));
    const sent = await sendToBot(stale, message());
    eve.open("live-session");
    const opened = await opening;

    expect(sent).toEqual({ deliveryId: "delivery-1" });
    expect(opened.sessionId).toBe("message-session");
    expect(await botRow()).toEqual({
      history_pending: false,
      session_id: "message-session",
    });
    expect(h.sendMessage.mock.calls.map((c) => c[1])).toEqual([
      "message-session",
    ]);
    expect(await attemptRow()).toMatchObject({
      session_id: "message-session",
      state: "accepted",
    });
    // The winner got the next generation (H-35); the loser waits in the registry until ended.
    expect(
      (
        await client.query(
          "SELECT session_id, generation, ended_at IS NOT NULL AS ended FROM bot_sessions ORDER BY session_id"
        )
      ).rows
    ).toEqual([
      { ended: true, generation: null, session_id: "live-session" },
      { ended: false, generation: 1, session_id: "message-session" },
    ]);
    expect(h.endSession.mock.calls.map((c) => c[1])).toEqual(["live-session"]);
  });

  it("a recovery target that lost the install is recorded before it is ended", async () => {
    await stored();
    h.createSession.mockImplementation(async (_call: unknown, op: string) => {
      if (op.startsWith("busy:recovery:")) {
        // Live installs its session while the message's replacement is being created.
        await client.query(
          "UPDATE bots SET session_id = 'live-session', history_pending = true WHERE id = $1",
          [botId]
        );
        return "unused-recovery";
      }
      return "live-session";
    });
    h.sendMessage.mockResolvedValue({ deliveryId: "delivery-1" });
    h.endSession.mockRejectedValue(new Error("eve unavailable"));

    await expect(sendToBot(await readBot(), message())).resolves.toEqual({
      deliveryId: "delivery-1",
    });

    expect(h.sendMessage.mock.calls.map((c) => c[1])).toEqual(["live-session"]);
    expect(
      await one(
        "SELECT generation, ended_at FROM bot_sessions WHERE session_id = 'unused-recovery'"
      )
    ).toEqual({ ended_at: null, generation: null });
    // eve was down: the orphan sweeper ends it later.
    await client.query(
      "UPDATE bot_sessions SET created_at = now() - interval '5 minutes'"
    );
    h.endSession.mockReset();
    h.endSession.mockResolvedValue(true);
    await expect(endOrphanSessions(() => call)).resolves.toEqual({
      ended: 1,
      pending: 0,
    });
    expect(h.endSession.mock.calls[0]?.[1]).toBe("unused-recovery");
  });

  it("a deploy refresh racing Live adopts the session instead of overwriting it", async () => {
    const deploy = gate<string>();
    h.createSession.mockReturnValue(deploy.wait);
    const stale = await readBot();
    const refreshing = replaceMainSession(stale, null, { call });
    await vi.waitFor(() => expect(h.createSession).toHaveBeenCalledTimes(1));
    const live = openSession(stale);
    await waitedForReservation();
    expect(h.createSession).toHaveBeenCalledTimes(1);
    deploy.open("deploy-session");
    const [refreshed, opened] = await Promise.all([refreshing, live]);
    expect(refreshed.opened).toBe(true);
    expect(opened.sessionId).toBe("deploy-session");
    expect(h.createSession).toHaveBeenCalledTimes(1);
  });

  it("losing the compare-and-set after createSession keeps the winner and queues the loser", async () => {
    h.createSession.mockImplementation(async () => {
      // A writer outside the reservation (old code during a rollout) installs its session.
      await client.query(
        "UPDATE bots SET session_id = 'winner' WHERE id = $1",
        [botId]
      );
      return "mine";
    });
    h.endSession.mockRejectedValue(new Error("eve unavailable"));

    const result = await replaceMainSession(await readBot(), null, { call });

    expect(result).toMatchObject({ opened: false, sessionId: "winner" });
    expect((await botRow())?.session_id).toBe("winner");
    expect(
      await one(
        "SELECT generation, ended_at, end_attempts FROM bot_sessions WHERE session_id = 'mine'"
      )
    ).toEqual({ end_attempts: 1, ended_at: null, generation: null });

    // The sweeper ends it later, and never touches the bot's live session.
    await client.query(
      "UPDATE bot_sessions SET created_at = now() - interval '5 minutes'"
    );
    await client.query(
      "INSERT INTO bot_sessions (session_id, bot_id, operation_id, created_at) VALUES ('winner', $1, 'x', now() - interval '5 minutes')",
      [botId]
    );
    h.endSession.mockReset();
    h.endSession.mockResolvedValue(true);
    await expect(endOrphanSessions(() => call)).resolves.toEqual({
      ended: 1,
      pending: 0,
    });
    expect(h.endSession).toHaveBeenCalledTimes(1);
    expect(h.endSession.mock.calls[0]?.[1]).toBe("mine");
    await expect(endOrphanSessions(() => call)).resolves.toEqual({
      ended: 0,
      pending: 0,
    });
  });

  it("a worker whose reservation expired never ends or overwrites the new worker's session", async () => {
    const old = gate<string>();
    h.createSession.mockReturnValueOnce(old.wait).mockResolvedValue("s-1");
    const stale = await readBot();
    const slow = replaceMainSession(stale, null, { call });
    await vi.waitFor(() => expect(h.createSession).toHaveBeenCalledTimes(1));
    // The slow worker's lease runs out; another reclaims it with the same operation id.
    await client.query(
      "UPDATE bot_session_openings SET lease_until = now() - interval '1 second'"
    );
    const fresh = await replaceMainSession(stale, null, { call });
    expect(h.createSession.mock.calls.map((c) => c[1])).toEqual([
      `${botId}:main:1`,
      `${botId}:main:1`,
    ]);
    old.open("s-1");
    const late = await slow;

    expect(fresh).toMatchObject({ opened: true, sessionId: "s-1" });
    expect(late).toMatchObject({ opened: false, sessionId: "s-1" });
    expect(h.endSession).not.toHaveBeenCalled();
    expect((await botRow())?.session_id).toBe("s-1");
  });

  it("gives up with a retryable error while another opener holds the reservation", async () => {
    await client.query(
      `INSERT INTO bot_session_openings (bot_id, token, generation, operation_id, lease_until)
       VALUES ($1, gen_random_uuid(), 1, 'x', now() + interval '1 minute')`,
      [botId]
    );
    let now = 0;
    await expect(
      replaceMainSession(await readBot(), null, {
        call,
        deps: {
          now: () => now,
          sleep: () => {
            now += 30_000;
            return Promise.resolve();
          },
        },
      })
    ).rejects.toThrow("being opened");
    expect(h.createSession).not.toHaveBeenCalled();
  });
});

describe("history-pending session that died before its first message (H-23)", () => {
  const second = "44444444-4444-4444-8444-444444444444";

  beforeEach(async () => {
    await client.query(
      "UPDATE bots SET session_id = 'live-session', history_pending = true WHERE id = $1",
      [botId]
    );
    await client.query(
      `INSERT INTO messages (id, bot_id, text, status, created_at)
       VALUES ('33333333-3333-4333-8333-333333333333', $1, 'Earlier question', 'accepted', '2026-11-01T10:00:00Z')`,
      [botId]
    );
    await stored(messageId, "First");
    await stored(second, "Second");
  });

  it("replaces it once, seeds the new session with the history and sends there", async () => {
    h.sendMessage
      .mockRejectedValueOnce(new Error(STRANDED))
      .mockResolvedValue({ deliveryId: "delivery-2" });
    h.createSession.mockResolvedValue("fresh-session");

    const sent = await sendToBot(await readBot(), message("First"));

    expect(sent).toEqual({ deliveryId: "delivery-2" });
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sendMessage.mock.calls[1]?.[1]).toBe("fresh-session");
    expect(h.sendMessage.mock.calls[1]?.[2].text).toContain(
      "User: Earlier question"
    );
    expect(h.sendMessage.mock.calls[1]?.[2].text).toContain("First");
    expect(await botRow()).toEqual({
      history_pending: false,
      session_id: "fresh-session",
    });
    expect(h.stop.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "live-session",
    });

    // The next POST goes straight to the new session, without history and without a 502.
    h.sendMessage.mockClear();
    h.sendMessage.mockResolvedValue({ deliveryId: "delivery-3" });
    await sendToBot(await readBot(), message("Second", second));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]?.[1]).toBe("fresh-session");
    expect(h.sendMessage.mock.calls[0]?.[2].text).toBe("Second");
  });

  it("seeds a pending session with exactly one of two concurrent first messages", async () => {
    h.sendMessage.mockResolvedValue({ deliveryId: "delivery-2" });
    const bot = await readBot();
    await Promise.all([
      sendToBot(bot, message("First")),
      sendToBot(bot, message("Second", second)),
    ]);
    const seededTexts = h.sendMessage.mock.calls.filter((c) =>
      String(c[2].text).startsWith("<prior_history>")
    );
    expect(seededTexts).toHaveLength(1);
    expect((await botRow())?.history_pending).toBe(false);
  });

  it("adopts a replacement another opener installed meanwhile instead of opening a third", async () => {
    h.sendMessage
      .mockRejectedValueOnce(new Error(STRANDED))
      .mockResolvedValue({ deliveryId: "delivery-2" });
    h.createSession.mockImplementation(async () => {
      await client.query(
        "UPDATE bots SET session_id = 'other-session', history_pending = true WHERE id = $1",
        [botId]
      );
      return "fresh-session";
    });

    await expect(sendToBot(await readBot(), message("First"))).resolves.toEqual(
      { deliveryId: "delivery-2" }
    );

    expect(h.sendMessage.mock.calls.map((c) => c[1])).toEqual([
      "live-session",
      "other-session",
    ]);
    expect((await botRow())?.session_id).toBe("other-session");
    expect(await attemptRow()).toMatchObject({
      session_id: "other-session",
      state: "accepted",
    });
    expect(h.endSession.mock.calls[0]?.[1]).toBe("fresh-session");
  });

  it("does not retry forever when the replacement refuses too", async () => {
    h.sendMessage.mockRejectedValue(new Error(STRANDED));
    h.createSession.mockResolvedValue("fresh-session");
    await expect(
      sendToBot(await readBot(), message("First"))
    ).rejects.toBeInstanceOf(UnknownDeliveryError);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    // Pinned to the replacement with its seeded envelope; a retry reconciles it there.
    expect(await attemptRow()).toMatchObject({
      session_id: "fresh-session",
      state: "unknown",
    });
    expect((await botRow())?.session_id).toBe("fresh-session");
  });
});

describe("delivery bound to its admitting session (H-21, H-36, N-04)", () => {
  const consumedIn = (sessionId: string, deliveryId: string, text: string) =>
    client.query(
      `INSERT INTO events (session_id, line, index, bot_id, type, data, at)
       VALUES ($1, 5, 0, $2, 'delivery.consumed', $3, now())`,
      [
        sessionId,
        botId,
        {
          data: { deliveryId, parts: [{ kind: "text", text }] },
          type: "delivery.consumed",
        },
      ]
    );
  const row = () =>
    one<{
      delivery_id: string | null;
      session_id: string | null;
      status: string;
    }>("SELECT status, session_id, delivery_id FROM messages WHERE id = $1", [
      messageId,
    ]);
  const deliver = async () =>
    deliverMessage({
      bot: await readBot(),
      fileIds: [],
      id: messageId,
      messageContext: null,
      stages: {},
      text: "Hola",
    });
  /** eve admitted it in A but the acknowledgement was lost; then the bot rotated to B. */
  const lostInA = async () => {
    await client.query("UPDATE bots SET session_id = 'A' WHERE id = $1", [
      botId,
    ]);
    h.sendMessage.mockRejectedValue(new Error(LOST_ACK));
    const lost = await deliver().catch((error: unknown) => error);
    await client.query("UPDATE bots SET session_id = 'B' WHERE id = $1", [
      botId,
    ]);
    h.sendMessage.mockReset();
    return lost;
  };

  beforeEach(async () => {
    await stored();
  });

  it("records the session before sending and projects it on acceptance", async () => {
    await client.query("UPDATE bots SET session_id = 'A' WHERE id = $1", [
      botId,
    ]);
    h.sendMessage.mockImplementation(async () => {
      // The delivery identity is durable before eve is called.
      expect(await attemptRow()).toMatchObject({
        session_id: "A",
        state: "sending",
      });
      return { deliveryId: "d-A" };
    });
    await expect(deliver()).resolves.toEqual({
      deliveryId: "d-A",
      sessionId: "A",
    });
    expect(await row()).toEqual({
      delivery_id: "d-A",
      session_id: "A",
      status: "accepted",
    });
  });

  it("after a lost acknowledgement and a rotation, the retry stays in the old session", async () => {
    expect(await lostInA()).toBeInstanceOf(UnknownDeliveryError);
    expect(await attemptRow()).toMatchObject({
      session_id: "A",
      state: "unknown",
    });
    // eve returns the original receipt for the same idempotency key in A.
    h.sendMessage.mockResolvedValue({ deliveryId: "d-A" });

    await expect(deliver()).resolves.toEqual({
      deliveryId: "d-A",
      sessionId: "A",
    });
    expect(h.sendMessage.mock.calls.map((c) => c[1])).toEqual(["A"]);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ session_id: "A", status: "accepted" });
  });

  it("an old session gone without consuming it gets exactly one new attempt in the winning session", async () => {
    await lostInA();
    h.sendMessage
      .mockRejectedValueOnce(new Error(STRANDED))
      .mockResolvedValue({ deliveryId: "d-B" });
    h.createSession.mockResolvedValue("unused");

    await expect(deliver()).resolves.toEqual({
      deliveryId: "d-B",
      sessionId: "B",
    });
    // A was read for evidence before the message moved, and the bot kept B (no third session).
    expect(h.syncBotSession.mock.calls[0]?.[1]).toBe("A");
    expect(h.sendMessage.mock.calls.map((c) => c[1])).toEqual(["A", "B"]);
    expect((await botRow())?.session_id).toBe("B");
    expect(h.endSession.mock.calls.map((c) => c[1])).toEqual(["unused"]);
    expect(await row()).toMatchObject({ session_id: "B", status: "accepted" });
  });

  it("a dead session that consumed the message settles it there instead of resending", async () => {
    await lostInA();
    await consumedIn(
      "A",
      "d-A",
      "<prior_history>\nx\n</prior_history>\n\nHola"
    );
    h.sendMessage.mockRejectedValueOnce(new Error(STRANDED));

    await expect(deliver()).resolves.toEqual({
      deliveryId: "d-A",
      sessionId: "A",
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({
      delivery_id: "d-A",
      session_id: "A",
      status: "accepted",
    });
  });

  it("an unreadable old session leaves the message pinned, not moved", async () => {
    await lostInA();
    h.sendMessage.mockRejectedValueOnce(new Error(STRANDED));
    h.syncBotSession.mockRejectedValue(new Error("eve stream failed: 503"));

    await expect(deliver()).rejects.toBeInstanceOf(UnknownDeliveryError);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.createSession).not.toHaveBeenCalled();
    expect(await attemptRow()).toMatchObject({
      session_id: "A",
      state: "unknown",
    });
    expect((await row())?.status).toBe("pending");
  });

  it("accepted and failed in both orders: the receipt wins, a stale failure loses", async () => {
    // (a) a failure first, then the authoritative admission: it is promoted.
    await markMessageFailed(messageId, new Error("eve send failed: 500"));
    expect((await row())?.status).toBe("failed");
    await expect(acceptMessage(messageId, "d-1", "A")).resolves.toBe(true);
    // (b) a late failure after the admission never downgrades it.
    await markMessageFailed(messageId, new Error("eve send failed: 500"));
    expect(await row()).toEqual({
      delivery_id: "d-1",
      session_id: "A",
      status: "accepted",
    });
    // An unknown outcome is never projected as failed.
    await client.query(
      "UPDATE messages SET status = 'pending', delivery_id = NULL WHERE id = $1",
      [messageId]
    );
    await markMessageFailed(messageId, new UnknownDeliveryError());
    expect((await row())?.status).toBe("pending");
  });
});

describe("message reconciliation (H-21)", () => {
  /** A delivery left by a request that ended (`unknown`) or died (`sending`), pinned to A. */
  const due = async (
    status: string,
    minutesAgo = 10,
    attemptState: "sending" | "unknown" = "unknown"
  ) => {
    await client.query(
      `INSERT INTO messages (id, bot_id, text, status, created_at)
       VALUES ($1, $2, 'Hola', $3, now() - make_interval(mins => $4))`,
      [messageId, botId, status, minutesAgo]
    );
    await client.query(
      `INSERT INTO message_delivery_attempts
         (bot_id, message_id, operation_id, session_id, state, seeded_text, posting_until, updated_at)
       VALUES ($1, $2, 'op', 'A', $3, 'Hola', now() - interval '1 minute', now() - interval '5 minutes')`,
      [botId, messageId, attemptState]
    );
  };
  const state = () =>
    one<{
      checks: number;
      failure: string | null;
      session_id: string | null;
      status: string;
    }>(
      "SELECT status, failure, checks, session_id FROM messages WHERE id = $1",
      [messageId]
    );
  const deps = (consumption: () => Promise<unknown>) => ({
    consumption: vi.fn(consumption) as never,
    failGone: failGoneAttempt,
    resend: resendPinned,
  });

  it("replays a crashed attempt into the same session with the same key, once across two runs", async () => {
    await due("pending", 10, "sending");
    h.sendMessage.mockResolvedValue({ deliveryId: "d-A" });
    const both = deps(async () => null);
    const [first, second] = await Promise.all([
      reconcileMessages(25, both),
      reconcileMessages(25, both),
    ]);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage.mock.calls[0]?.[1]).toBe("A");
    expect(h.sendMessage.mock.calls[0]?.[2]).toMatchObject({
      id: messageId,
      text: "Hola",
    });
    expect(first.accepted + second.accepted).toBe(1);
    expect(await state()).toMatchObject({
      session_id: "A",
      status: "accepted",
    });
    expect((await attemptRow())?.state).toBe("accepted");
  });

  it("fails an attempt whose session is gone without consumption, with a fixed reason, once", async () => {
    await due("pending");
    h.sendMessage.mockRejectedValue(new Error(STRANDED));
    const gone = deps(async () => null);
    await expect(reconcileMessages(25, gone)).resolves.toMatchObject({
      failed: 1,
    });
    expect(await state()).toMatchObject({
      failure: "session_gone",
      status: "failed",
    });
    expect((await attemptRow())?.state).toBe("failed");
    // Not picked again: it is never resent indefinitely.
    await expect(reconcileMessages(25, gone)).resolves.toMatchObject({
      failed: 0,
    });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("never fails an ambiguous attempt by age: unknown evidence backs off", async () => {
    await due("failed", 600);
    await expect(
      reconcileMessages(
        25,
        deps(async () => "unknown")
      )
    ).resolves.toMatchObject({ ambiguous: 1 });
    expect(h.sendMessage).not.toHaveBeenCalled();
    expect(await state()).toMatchObject({
      checks: 1,
      failure: null,
      status: "failed",
    });
  });

  it("promotes a failed attempt when its consumption shows up", async () => {
    await due("failed");
    await expect(
      reconcileMessages(
        25,
        deps(async () => ({ deliveryId: "d-A" }))
      )
    ).resolves.toMatchObject({ accepted: 1 });
    expect(await state()).toMatchObject({
      session_id: "A",
      status: "accepted",
    });
    expect((await attemptRow())?.state).toBe("accepted");
  });
});

describe("history order across sessions (H-35)", () => {
  const event = (
    sessionId: string,
    line: number,
    type: string,
    data: Record<string, unknown>,
    at: string
  ) =>
    client.query(
      `INSERT INTO events (session_id, line, index, bot_id, type, data, at)
       VALUES ($1, $2, 0, $3, $4, $5, $6)`,
      [sessionId, line, botId, type, { data, type }, at]
    );
  const reply = (sessionId: string, line: number, value: string, at: string) =>
    event(
      sessionId,
      line,
      "content.completed",
      { kind: "text", phase: "reply", value },
      at
    );
  const said = async (
    id: string,
    sessionId: string,
    line: number,
    text: string,
    createdAt: string
  ) => {
    await client.query(
      `INSERT INTO messages (id, bot_id, text, status, session_id, delivery_id, created_at)
       VALUES ($1, $2, $3, 'accepted', $4, $5, $6)`,
      [id, botId, text, sessionId, `d-${id}`, createdAt]
    );
    await event(
      sessionId,
      line,
      "delivery.admitted",
      { deliveryId: `d-${id}` },
      createdAt
    );
  };

  it("orders by session generation, then line, never by the two clocks", async () => {
    await client.query(
      `INSERT INTO bot_sessions (session_id, bot_id, generation, operation_id)
       VALUES ('S1', $1, 1, 'x'), ('S2', $1, 2, 'y')`,
      [botId]
    );
    // Pre-registry session: only its own items fall back to timestamps, and come first.
    await reply("legacy", 9, "legacy answer", "2026-11-09T00:00:00Z");
    // Same local lines in both sessions, timestamps crossed between them.
    await said(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "S1",
      3,
      "first",
      "2026-11-05T10:00:00Z"
    );
    await reply("S1", 4, "first answer", "2026-11-08T23:00:00Z");
    await said(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "S2",
      3,
      "second",
      "2026-11-05T09:00:00Z"
    );
    // A record without `at`, stored with the cron's clock: its line still places it.
    await reply("S2", 4, "second answer", "2026-11-10T00:00:00Z");
    await said(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "S2",
      6,
      "third",
      "2026-11-05T09:30:00Z"
    );

    expect((await recentHistory(await readBot())).split("\n")).toEqual([
      "You: legacy answer",
      "User: first",
      "You: first answer",
      "User: second",
      "You: second answer",
      "User: third",
    ]);
  });
});

describe("turn follower bound to the admitting session (N-04)", () => {
  const admitted = (sessionId: string, line: number, type: string) =>
    client.query(
      `INSERT INTO events (session_id, line, index, bot_id, type, data, at)
       VALUES ($1, $2, 0, $3, $4, $5, now())`,
      [sessionId, line, botId, type, { data: { deliveryId: "d-1" }, type }]
    );

  it("keeps reading session A after the bot rotated to B", async () => {
    await client.query("UPDATE bots SET session_id = 'B' WHERE id = $1", [
      botId,
    ]);
    h.getBot.mockResolvedValue(await readBot());
    await admitted("A", 3, "delivery.admitted");
    await admitted("A", 4, "delivery.settled");

    await syncTurnWorkflow(slug, "d-1", "A");

    expect(h.syncBotSession.mock.calls.map((c) => c[1])).toEqual(["A"]);
  });

  it("a v1 run without a captured session finds it from the stored admission", async () => {
    await client.query("UPDATE bots SET session_id = 'B' WHERE id = $1", [
      botId,
    ]);
    h.getBot.mockResolvedValue(await readBot());
    await admitted("A", 3, "delivery.admitted");
    await admitted("A", 4, "delivery.settled");

    await syncTurnWorkflow(slug, "d-1");

    expect(h.syncBotSession.mock.calls.map((c) => c[1])).toEqual(["A"]);
  });

  it("a v1 run with no stored admission keeps waiting instead of adopting the current session", async () => {
    await client.query("UPDATE bots SET session_id = 'B' WHERE id = $1", [
      botId,
    ]);
    h.getBot.mockResolvedValue(await readBot());
    let steps = 0;
    h.sleep.mockImplementation(() => {
      steps += 1;
      return steps === 2
        ? Promise.reject(new Error("stop polling"))
        : Promise.resolve();
    });
    await expect(syncTurnWorkflow(slug, "d-1")).rejects.toThrow("stop polling");
    // B was only searched for the admission; nothing marked the turn settled there.
    expect(h.syncBotSession.mock.calls.every((c) => c[1] === "B")).toBe(true);
  });
});
