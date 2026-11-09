import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
import { botsMigrations, migration } from "./lib/bots/test-helpers";
import { buildRecoveryPacket } from "./lib/chat/recovery";
import {
  botSessionOpenings,
  botSessions,
  bots,
  consultations,
  cursors,
  events,
  messageDeliveryAttempts,
  messages,
  sessionRecoveries,
} from "./lib/db/schema";

const transport = vi.hoisted(() => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  sendMessage: vi.fn(),
  stopComputerObserved: vi.fn(),
}));

vi.mock("./lib/eve/client", () => ({
  createSession: transport.createSession,
  endSession: transport.endSession,
  sendMessage: transport.sendMessage,
}));
vi.mock("./lib/live", () => ({
  stopComputerObserved: transport.stopComputerObserved,
}));
vi.mock("./lib/chat/store", () => ({
  botCall: () => ({ token: async () => "fixture", url: "http://unused.test" }),
}));
vi.mock("./lib/firesides/store", () => ({
  firesideContext: async () => [],
}));

const schema = {
  botSessionOpenings,
  botSessions,
  bots,
  consultations,
  cursors,
  events,
  messageDeliveryAttempts,
  messages,
  sessionRecoveries,
};
const BOT_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_MESSAGE_ID = "33333333-3333-4333-8333-333333333333";
const SESSION_GONE = 'eve send failed: 409 {"code":"session_not_active"}';
const outgoing = { files: [], id: MESSAGE_ID, text: "Continue the review." };

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let sending: typeof import("./lib/chat/send");

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => {
    throw new Error("Deferred promise has not initialized.");
  };
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function botRow() {
  const [row] = await database.select().from(bots).where(eq(bots.id, BOT_ID));
  if (!row) {
    throw new Error("The fixture bot is missing.");
  }
  return row;
}

async function attemptRow() {
  const [row] = await database
    .select()
    .from(messageDeliveryAttempts)
    .where(eq(messageDeliveryAttempts.messageId, MESSAGE_ID));
  if (!row) {
    throw new Error("The persisted delivery is missing.");
  }
  return row;
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
      client_context jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivery_id text,
      file_ids jsonb NOT NULL DEFAULT '[]',
      payload_hash text,
      status text NOT NULL DEFAULT 'pending',
      text text NOT NULL
    );
    CREATE TABLE events (
      session_id text NOT NULL,
      bot_id uuid NOT NULL,
      line integer NOT NULL,
      index integer NOT NULL,
      type text NOT NULL,
      data jsonb NOT NULL,
      at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (session_id, line, index)
    );
    CREATE TABLE consultations (child_session_id text);
    CREATE TABLE cursors (
      session_id text PRIMARY KEY,
      bot_id uuid NOT NULL,
      next_line integer NOT NULL DEFAULT 0
    );
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
  `);
  await client.exec(
    readFileSync(
      new URL("./drizzle/0025_session_recovery.sql", import.meta.url),
      "utf8"
    )
  );
  // The state-machine migrations the merged schema maps (bots 0028/0029, 0020's column, 0026).
  await client.exec(botsMigrations());
  await client.exec(
    "ALTER TABLE messages ADD COLUMN selected_skills jsonb NOT NULL DEFAULT '[]'"
  );
  await client.exec(migration("0026_session_bindings.sql"));
  database = drizzle(client, { schema });
  vi.doMock("./lib/db", () => ({ ...schema, db: () => database }));
  vi.resetModules();
  sending = await import("./lib/chat/send");
});

beforeEach(async () => {
  vi.clearAllMocks();
  transport.createSession.mockReset().mockResolvedValue("replacement");
  transport.sendMessage
    .mockReset()
    .mockResolvedValue({ deliveryId: "receipt" });
  transport.endSession.mockReset().mockResolvedValue(undefined);
  transport.stopComputerObserved.mockReset().mockResolvedValue(undefined);
  await client.exec(`
    TRUNCATE session_recoveries, message_delivery_attempts, events, messages,
      consultations, cursors, bots CASCADE;
  `);
  await database.insert(bots).values({
    description: "Fixture bot",
    id: BOT_ID,
    name: "Fixture",
    sessionId: "original",
    slug: "fixture",
  });
  await database.insert(messages).values({
    botId: BOT_ID,
    id: MESSAGE_ID,
    text: outgoing.text,
  });
});

afterAll(async () => {
  await client.close();
});

describe("chat transport persistence", () => {
  it("returns the accepted receipt on retry even after the bot changes session", async () => {
    const first = await sending.sendToBot(await botRow(), outgoing);
    await database.update(bots).set({ sessionId: "newer" });
    const second = await sending.sendToBot(await botRow(), outgoing);

    expect(second).toEqual(first);
    expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    expect(transport.createSession).not.toHaveBeenCalled();
    expect(await attemptRow()).toMatchObject({
      deliveryId: "receipt",
      sessionId: "original",
      state: "accepted",
    });
  });

  it("does not move a lost-ack delivery when its old session later retires", async () => {
    transport.sendMessage.mockRejectedValue(new Error("Connection ended."));
    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );
    expect(await attemptRow()).toMatchObject({
      sessionId: "original",
      state: "unknown",
    });

    await database.update(bots).set({ sessionId: "newer" });
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));
    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );

    expect((await attemptRow()).sessionId).toBe("original");
    expect((await botRow()).sessionId).toBe("newer");
    expect(transport.createSession).not.toHaveBeenCalled();
    expect(transport.stopComputerObserved).not.toHaveBeenCalled();
  });

  it("does not start another POST while the same message has a send in flight", async () => {
    const posted = deferred<void>();
    const release = deferred<void>();
    let requests = 0;
    transport.sendMessage.mockImplementation(async () => {
      requests += 1;
      if (requests > 1) {
        throw new Error("A second concurrent POST reached Eve.");
      }
      posted.resolve();
      await release.promise;
      return { deliveryId: "receipt" };
    });
    const bot = await botRow();
    const first = sending.sendToBot(bot, outgoing);
    await posted.promise;
    try {
      await expect(sending.sendToBot(bot, outgoing)).rejects.toThrow(
        sending.UnknownDeliveryError
      );
      expect(transport.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await first;
    }
    expect(await attemptRow()).toMatchObject({
      deliveryId: "receipt",
      sessionId: "original",
      state: "accepted",
    });
  });

  it("fences a late rejection after a newer lease already recorded acceptance", async () => {
    const posted = deferred<void>();
    const release = deferred<void>();
    let requests = 0;
    transport.sendMessage.mockImplementation(async () => {
      requests += 1;
      if (requests === 1) {
        posted.resolve();
        await release.promise;
        throw new Error(SESSION_GONE);
      }
      return { deliveryId: "receipt" };
    });
    const bot = await botRow();
    const first = sending
      .sendToBot(bot, outgoing)
      .catch((error: unknown) => error);
    await posted.promise;
    await database
      .update(messageDeliveryAttempts)
      .set({ postingUntil: new Date("2020-01-01T00:00:00.000Z") });
    try {
      expect(await sending.sendToBot(bot, outgoing)).toEqual({
        deliveryId: "receipt",
      });
    } finally {
      release.resolve();
      await first;
    }

    expect(transport.createSession).not.toHaveBeenCalled();
    expect(transport.stopComputerObserved).not.toHaveBeenCalled();
    expect((await botRow()).sessionId).toBe("original");
    expect(await attemptRow()).toMatchObject({
      deliveryId: "receipt",
      sessionId: "original",
      state: "accepted",
    });
  });

  it("persists the packet before creation and sends only to the reserved replacement", async () => {
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) => {
        if (sessionId === "original") {
          return Promise.reject(new Error(SESSION_GONE));
        }
        return Promise.resolve({ deliveryId: "replacement-receipt" });
      }
    );
    transport.createSession.mockImplementation(async () => {
      const rows = await database.select().from(sessionRecoveries);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        botId: BOT_ID,
        sourceSessionId: "original",
      });
      expect(rows[0]?.packet).toHaveProperty("version", 1);
      expect((await botRow()).sessionId).toBe("original");
      return "replacement";
    });

    const result = await sending.sendToBot(await botRow(), outgoing);
    expect(result.deliveryId).toBe("replacement-receipt");
    expect((await botRow()).sessionId).toBe("replacement");
    expect(await attemptRow()).toMatchObject({
      deliveryId: "replacement-receipt",
      sessionId: "replacement",
      state: "accepted",
    });
  });

  it("shares one canonical session between a Live open and the first user message", async () => {
    await database.update(bots).set({ sessionId: null });
    const bot = await botRow();
    transport.createSession.mockImplementation(
      (_call: unknown, operationId: string) =>
        Promise.resolve(`session:${operationId}`)
    );
    const [opened] = await Promise.all([
      sending.openSession(bot),
      sending.sendToBot(bot, outgoing),
    ]);

    const current = await botRow();
    expect(opened.sessionId).toBe(current.sessionId);
    expect((await attemptRow()).sessionId).toBe(current.sessionId);
    expect(
      transport.sendMessage.mock.calls.every(
        (call) => call[1] === current.sessionId
      )
    ).toBe(true);
  });

  it("activates a persisted creating target before another message can use it", async () => {
    await database.insert(sessionRecoveries).values({
      botId: BOT_ID,
      messageId: OTHER_MESSAGE_ID,
      operationId: `busy:recovery:${BOT_ID}:${OTHER_MESSAGE_ID}`,
      packet: buildRecoveryPacket([], [], "original"),
      reservedSessionId: "prepared-target",
      sourceSessionId: "original",
      state: "creating",
    });
    transport.sendMessage.mockImplementation(
      async (_call: unknown, sessionId: string) => {
        if (sessionId === "original") {
          throw new Error(SESSION_GONE);
        }
        expect(sessionId).toBe("prepared-target");
        expect((await botRow()).sessionId).toBe(sessionId);
        const [recovery] = await database.select().from(sessionRecoveries);
        expect(recovery?.state).toBe("active");
        return { deliveryId: "canonical-receipt" };
      }
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "canonical-receipt",
    });
    expect(transport.createSession).not.toHaveBeenCalled();
  });

  it("continues a prepared reservation after its original request disappears", async () => {
    const operationId = `busy:recovery:${BOT_ID}:${OTHER_MESSAGE_ID}`;
    await database.insert(sessionRecoveries).values({
      botId: BOT_ID,
      messageId: OTHER_MESSAGE_ID,
      operationId,
      packet: buildRecoveryPacket([], [], "original"),
      sourceSessionId: "original",
      state: "prepared",
    });
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) =>
        sessionId === "original"
          ? Promise.reject(new Error(SESSION_GONE))
          : Promise.resolve({ deliveryId: "resumed-receipt" })
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "resumed-receipt",
    });
    expect(transport.createSession).toHaveBeenCalledWith(
      expect.anything(),
      operationId
    );
    expect((await botRow()).sessionId).toBe("replacement");
    expect((await attemptRow()).sessionId).toBe("replacement");
  });

  it("never shares a stale active target that is no longer the bot's session", async () => {
    await database.insert(sessionRecoveries).values({
      botId: BOT_ID,
      messageId: OTHER_MESSAGE_ID,
      operationId: `busy:recovery:${BOT_ID}:${OTHER_MESSAGE_ID}`,
      packet: buildRecoveryPacket([], [], "earlier-source"),
      reservedSessionId: "retired-target",
      sourceSessionId: "earlier-source",
      state: "active",
    });
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) => {
        if (sessionId === "original") {
          return Promise.reject(new Error(SESSION_GONE));
        }
        if (sessionId === "retired-target") {
          return Promise.reject(new Error("A retired target received a POST."));
        }
        return Promise.resolve({ deliveryId: "current-receipt" });
      }
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "current-receipt",
    });
    expect(
      transport.sendMessage.mock.calls.some(
        (call) => call[1] === "retired-target"
      )
    ).toBe(false);
    expect((await botRow()).sessionId).toBe("replacement");
  });

  it("replaces a retired session even when its earlier recovery completed successfully", async () => {
    await database.insert(sessionRecoveries).values({
      botId: BOT_ID,
      messageId: OTHER_MESSAGE_ID,
      operationId: `busy:recovery:${BOT_ID}:${OTHER_MESSAGE_ID}`,
      packet: buildRecoveryPacket([], [], "earlier-source"),
      reservedSessionId: "original",
      sourceSessionId: "earlier-source",
      state: "completed",
    });
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) =>
        sessionId === "original"
          ? Promise.reject(new Error(SESSION_GONE))
          : Promise.resolve({ deliveryId: "new-generation-receipt" })
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "new-generation-receipt",
    });
    expect((await botRow()).sessionId).toBe("replacement");
  });

  it("never activates or posts to a generation that failed while creation was in flight", async () => {
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));
    transport.createSession.mockImplementation(async () => {
      await database.update(sessionRecoveries).set({
        reservedSessionId: "failed-generation",
        state: "failed",
      });
      return "failed-generation";
    });

    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );
    expect((await botRow()).sessionId).toBe("original");
    expect(
      transport.sendMessage.mock.calls.some(
        (call) => call[1] === "failed-generation"
      )
    ).toBe(false);
  });

  it("does not close a canonical session completed by a helper while creation returns late", async () => {
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));
    transport.createSession.mockImplementation(async () => {
      await database.update(sessionRecoveries).set({
        reservedSessionId: "replacement",
        state: "completed",
      });
      await database.update(bots).set({ sessionId: "replacement" });
      await database.update(messageDeliveryAttempts).set({
        deliveryId: "helper-receipt",
        sessionId: "replacement",
        state: "accepted",
      });
      return "replacement";
    });

    await sending.sendToBot(await botRow(), outgoing).catch(() => undefined);

    expect(transport.endSession).not.toHaveBeenCalled();
    expect((await botRow()).sessionId).toBe("replacement");
    expect(await attemptRow()).toMatchObject({
      deliveryId: "helper-receipt",
      sessionId: "replacement",
      state: "accepted",
    });
    const [recovery] = await database.select().from(sessionRecoveries);
    expect(recovery?.state).toBe("completed");
  });

  it("reconciles a lost creation acknowledgement with the same persisted operation", async () => {
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) =>
        sessionId === "original"
          ? Promise.reject(new Error(SESSION_GONE))
          : Promise.resolve({ deliveryId: "reconciled-receipt" })
    );
    transport.createSession
      .mockRejectedValueOnce(new Error("Creation acknowledgement lost."))
      .mockResolvedValue("replacement");
    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow();

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "reconciled-receipt",
    });
    expect(transport.createSession).toHaveBeenCalledTimes(2);
    expect(transport.createSession.mock.calls[0]?.[1]).toBe(
      transport.createSession.mock.calls[1]?.[1]
    );
  });

  it("retries a replacement with the exact persisted seeded envelope", async () => {
    const replacementPosts: unknown[] = [];
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string, message: unknown) => {
        if (sessionId === "original") {
          return Promise.reject(new Error(SESSION_GONE));
        }
        replacementPosts.push(message);
        if (replacementPosts.length < 3) {
          return Promise.reject(
            new Error("connection ended after replacement admission")
          );
        }
        return Promise.resolve({ deliveryId: "replacement-receipt" });
      }
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );
    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "replacement-receipt",
    });
    expect(replacementPosts).toHaveLength(3);
    expect(replacementPosts[1]).toEqual(replacementPosts[2]);
  });

  it("closes an unused recovery target when Live wins the canonical session CAS", async () => {
    await database.update(bots).set({ sessionId: null });
    const bot = await botRow();
    const creating = deferred<void>();
    const release = deferred<void>();
    transport.createSession.mockImplementation(
      async (_call: unknown, operationId: string) => {
        if (operationId.startsWith("busy:recovery:")) {
          creating.resolve();
          await release.promise;
          return "unused-recovery";
        }
        return "live-winner";
      }
    );
    const message = sending.sendToBot(bot, outgoing);
    await creating.promise;
    try {
      expect((await sending.openSession(bot)).sessionId).toBe("live-winner");
    } finally {
      release.resolve();
    }
    await expect(message).resolves.toEqual({ deliveryId: "receipt" });

    expect(transport.endSession).toHaveBeenCalledWith(
      expect.anything(),
      "unused-recovery"
    );
    expect(
      transport.endSession.mock.calls.some((call) => call[1] === "live-winner")
    ).toBe(false);
    expect((await botRow()).sessionId).toBe("live-winner");
    expect((await attemptRow()).sessionId).toBe("live-winner");
  });

  it("does not close a historical target with another helper's unknown delivery", async () => {
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));
    transport.createSession.mockImplementation(async () => {
      // Another helper activated and posted to this target while the older
      // create request was in flight. A later generation is now canonical.
      await database.update(sessionRecoveries).set({
        reservedSessionId: "historical-target",
        state: "failed",
      });
      await database.update(bots).set({ sessionId: "newer-canonical" });
      await database.update(messageDeliveryAttempts).set({
        sessionId: "historical-target",
        state: "unknown",
      });
      return "historical-target";
    });

    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );

    expect(transport.endSession).not.toHaveBeenCalled();
    expect((await botRow()).sessionId).toBe("newer-canonical");
    expect(await attemptRow()).toMatchObject({
      sessionId: "historical-target",
      state: "unknown",
    });
  });

  it("recovers a plan and its actual dispatch identity beyond the recent event window", async () => {
    const savedPlan = {
      dispatchCount: 0,
      id: "long-plan",
      revision: 2,
      steps: [
        {
          assignee: "agent",
          dependsOn: [],
          expectedResult: "private expected result",
          id: "inspect",
          status: "pending",
          title: "Inspect prior work",
        },
      ],
      title: "Saved long work",
    };
    const facts = [
      {
        data: {
          callId: "plan-call",
          capability: { name: "manage_plan" },
          input: { action: "get" },
        },
        type: "call.requested",
      },
      {
        data: {
          callId: "plan-call",
          outcome: "completed",
          output: { plan: savedPlan },
        },
        type: "call.settled",
      },
      {
        data: {
          callId: "dispatch-call",
          capability: { name: "dispatch_plan_step" },
          input: {
            message: "private brief",
            planId: "long-plan",
            revision: 2,
            stepId: "inspect",
            target: "agent",
          },
        },
        type: "call.requested",
      },
      {
        data: { callId: "dispatch-call", taskId: "actual-dispatch-task" },
        type: "call.started",
      },
      ...Array.from({ length: 2005 }, (_, index) => ({
        data: { callId: `read-${index}`, capability: { name: "read_file" } },
        type: "call.requested",
      })),
    ];
    await database.insert(events).values(
      facts.map((fact, index) => ({
        at: new Date("2026-11-09T10:00:00.000Z"),
        botId: BOT_ID,
        data: { data: fact.data, scope: {} },
        index: 0,
        line: index + 1,
        sessionId: "original",
        type: fact.type,
      }))
    );
    transport.sendMessage.mockImplementation(
      (_call: unknown, sessionId: string) =>
        sessionId === "original"
          ? Promise.reject(new Error(SESSION_GONE))
          : Promise.resolve({ deliveryId: "long-plan-receipt" })
    );

    await expect(sending.sendToBot(await botRow(), outgoing)).resolves.toEqual({
      deliveryId: "long-plan-receipt",
    });

    const [recovery] = await database.select().from(sessionRecoveries);
    expect(recovery?.planSnapshot).toMatchObject({
      dispatchCount: 1,
      id: "long-plan",
      steps: [
        { id: "inspect", status: "blocked", taskId: "actual-dispatch-task" },
      ],
    });
    expect(recovery?.packet).toMatchObject({
      plan: {
        id: "long-plan",
        steps: [{ status: "blocked", taskId: "actual-dispatch-task" }],
      },
    });
    expect(JSON.stringify(recovery?.packet)).not.toContain(
      "private expected result"
    );
    expect(JSON.stringify(recovery?.packet)).not.toContain("private brief");
  });

  it("does not activate a replacement when dispatch facts refer to a missing plan", async () => {
    await database.insert(events).values({
      at: new Date("2026-11-09T10:00:00.000Z"),
      botId: BOT_ID,
      data: {
        data: {
          callId: "uncertain-dispatch",
          capability: { name: "dispatch_plan_step" },
          input: { planId: "missing-plan", revision: 2, stepId: "work" },
        },
        scope: {},
      },
      index: 0,
      line: 1,
      sessionId: "original",
      type: "call.requested",
    });
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));

    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      "The saved plan could not be recovered within its lookup bound."
    );
    expect(transport.createSession).not.toHaveBeenCalled();
    expect((await botRow()).sessionId).toBe("original");
  });

  it("does not activate a session when recovery history cannot be read", async () => {
    await database.update(bots).set({ sessionId: null });
    const bot = await botRow();
    await client.exec("ALTER TABLE events RENAME TO unavailable_events;");
    try {
      await expect(sending.sendToBot(bot, outgoing)).rejects.toThrow();
      expect(transport.createSession).not.toHaveBeenCalled();
      expect((await botRow()).sessionId).toBeNull();
    } finally {
      await client.exec("ALTER TABLE unavailable_events RENAME TO events;");
    }
  });

  it("stays pinned if the receipt cannot be written after Eve accepted it", async () => {
    transport.sendMessage.mockImplementationOnce(async () => {
      await client.exec(
        "ALTER TABLE message_delivery_attempts RENAME TO unavailable_attempts;"
      );
      return { deliveryId: "receipt" };
    });
    try {
      await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
        sending.UnknownDeliveryError
      );
    } finally {
      await client.exec(
        "ALTER TABLE unavailable_attempts RENAME TO message_delivery_attempts;"
      );
    }
    transport.sendMessage.mockRejectedValue(new Error(SESSION_GONE));
    await expect(sending.sendToBot(await botRow(), outgoing)).rejects.toThrow(
      sending.UnknownDeliveryError
    );
    expect((await attemptRow()).sessionId).toBe("original");
    expect(transport.createSession).not.toHaveBeenCalled();
  });

  it("keeps recovery tables outside anonymous and authenticated API access", async () => {
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
      anon_read: boolean;
      user_read: boolean;
    }>(`
      SELECT relname, relrowsecurity,
        has_table_privilege('anon', oid, 'SELECT') AS anon_read,
        has_table_privilege('authenticated', oid, 'SELECT') AS user_read
      FROM pg_class
      WHERE relname IN ('message_delivery_attempts', 'session_recoveries')
      ORDER BY relname;
    `);
    expect(result.rows).toHaveLength(2);
    expect(
      result.rows.every(
        (row) => row.relrowsecurity && !row.anon_read && !row.user_read
      )
    ).toBe(true);
  });
});
