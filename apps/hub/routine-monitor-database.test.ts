import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { deployMigration } from "./lib/bots/test-helpers";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";
import {
  observeRoutineRun,
  recoverRoutineRuns,
  refreshRoutineRun,
} from "./lib/routines/monitor";

const h = vi.hoisted(() => ({
  cursorOf: vi.fn(),
  database: null as unknown,
  readStream: vi.fn(),
  routineBotCall: vi.fn(),
  saver: vi.fn(),
  syncSession: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  bots: schema.bots,
  db: () => h.database,
  events: schema.events,
  messages: schema.messages,
  routineRuns: schema.routineRuns,
}));
vi.mock("@/lib/chat/store", () => ({ cursorOf: h.cursorOf, saver: h.saver }));
vi.mock("@/lib/chat/sync", () => ({ syncSession: h.syncSession }));
vi.mock("@/lib/eve/client", () => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  readStream: h.readStream,
}));
vi.mock("@/lib/routines/call", () => ({ routineBotCall: h.routineBotCall }));

const botId = "11111111-1111-4111-8111-111111111111";
const routineId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const sessionId = "pinned-session";
const currentSessionId = "current-session";
const deliveryId = "routine-delivery";
const fixedNow = new Date("2026-11-02T12:00:00.000Z");

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;

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
      deletion_state text, deletion_token uuid, deletion_requested_at timestamptz,
      deletion_attempts integer NOT NULL DEFAULT 0, deletion_next_attempt_at timestamptz,
      deletion_last_error text, deletion_project_id text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      text text NOT NULL,
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      delivery_id text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
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
  `);
  // Bots columns added by later SQL migrations (bots predates drizzle/).
  await client.exec(deployMigration());
  await client.exec(
    readFileSync(
      fileURLToPath(new URL("./drizzle/0011_routines.sql", import.meta.url)),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0024_routine_next_run_nullable.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL(
          "./drizzle/0030_routine_recovery_schedule_outbox.sql",
          import.meta.url
        )
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0020_message_skill_snapshots.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0026_session_bindings.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  h.database = database;
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  await client.exec(
    "DELETE FROM events; DELETE FROM messages; DELETE FROM routine_runs; DELETE FROM routines; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name, session_id) VALUES
      ('${botId}', 'sales', 'Sales', '${currentSessionId}');
  `);
  await database.insert(schema.routines).values({
    botId,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    id: routineId,
    name: "Morning report",
    prompt: "Read the inbox.",
    time: "09:30",
    timeZone: "America/Argentina/Cordoba",
  });

  h.readStream.mockReset().mockImplementation(async function* () {
    yield* [];
  });
  h.routineBotCall
    .mockReset()
    .mockReturnValue({ token: vi.fn(), url: "https://sales.example" });
  h.cursorOf.mockReset().mockResolvedValue(0);
  h.saver.mockReset().mockReturnValue(vi.fn());
  h.syncSession
    .mockReset()
    .mockImplementation(
      async ({ read }: { read: (start: number) => AsyncIterable<unknown> }) => {
        // Read the pinned transport once, but keep facts in this test's database so the monitor's
        // real SQL queries are what decide the terminal state.
        for await (const _record of read(0)) {
          String(_record);
        }
      }
    );
});

async function seedRun(
  overrides: Partial<typeof schema.routineRuns.$inferInsert> = {}
) {
  await database.insert(schema.routineRuns).values({
    botId,
    deliveryId,
    id: runId,
    prompt: "<routine_execution>\nRead the inbox.",
    routineId,
    scheduledFor: new Date("2026-11-02T12:30:00.000Z"),
    sessionId,
    status: "dispatched",
    ...overrides,
  });
  await database
    .insert(schema.messages)
    .values({ botId, id: runId, status: "pending", text: "Read the inbox." });
}

async function fact(
  line: number,
  type: string,
  data: Record<string, unknown>,
  eventSession = sessionId
) {
  const stored = { data, type };
  await database.insert(schema.events).values({
    at: fixedNow,
    botId,
    data: stored,
    index: 0,
    line,
    sessionId: eventSession,
    type,
  });
}

async function storedRun() {
  const [run] = await database
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.id, runId));
  assert(run);
  return run;
}

async function storedMessage() {
  const [message] = await database
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.id, runId));
  assert(message);
  return message;
}

const dispatchedAt = new Date("2026-11-02T12:30:05.000Z");
const afterWorkflow = new Date("2026-11-02T15:00:00.000Z"); // past the workflow's two hours

async function storedBot() {
  const [bot] = await database
    .select()
    .from(schema.bots)
    .where(eq(schema.bots.id, botId));
  assert(bot);
  return bot;
}

describe("routine sweep after the workflow stops following a run", () => {
  it("keeps a run paused on an open question dispatched and the bot's session in place", async () => {
    await seedRun({ startedAt: dispatchedAt });
    await database
      .update(schema.bots)
      .set({ sessionId })
      .where(eq(schema.bots.id, botId));
    await fact(1, "delivery.settled", {
      deliveryId,
      outcome: "awaiting-input",
      turnId: "routine-turn",
    });
    await fact(2, "turn.paused", {
      awaiting: [{ interactionId: "question-1" }],
      turnId: "routine-turn",
    });

    await expect(recoverRoutineRuns(afterWorkflow)).resolves.toEqual({
      awaitingInput: 1,
      checked: 1,
      errors: 0,
      released: 0,
      running: 0,
    });
    expect(await storedRun()).toMatchObject({
      awaitingInputAt: afterWorkflow,
      finishedAt: null,
      lastObservedAt: afterWorkflow,
      sessionId,
      status: "dispatched",
    });
    expect((await storedBot()).sessionId).toBe(sessionId);

    // A day later it is still waiting, still dispatched, and keeps when the wait began.
    const nextDay = new Date(afterWorkflow.getTime() + 24 * 60 * 60_000);
    await expect(recoverRoutineRuns(nextDay)).resolves.toMatchObject({
      awaitingInput: 1,
    });
    expect(await storedRun()).toMatchObject({
      awaitingInputAt: afterWorkflow,
      lastObservedAt: nextDay,
      status: "dispatched",
    });

    // The user answers; the resumed turn is running, not waiting, and still not released by age.
    await fact(3, "interaction.settled", { interactionId: "question-1" });
    expect(await observeRoutineRun(runId, nextDay)).toBe("running");
    expect(await storedRun()).toMatchObject({
      awaitingInputAt: null,
      status: "dispatched",
    });
  });

  it("leaves runs observed in the last ten minutes to whoever is following them", async () => {
    await seedRun({ startedAt: dispatchedAt });
    await expect(recoverRoutineRuns(fixedNow)).resolves.toMatchObject({
      checked: 0,
    });
    await database
      .update(schema.routineRuns)
      .set({ lastObservedAt: new Date(afterWorkflow.getTime() - 60_000) })
      .where(eq(schema.routineRuns.id, runId));
    await expect(recoverRoutineRuns(afterWorkflow)).resolves.toMatchObject({
      checked: 0,
    });
    expect(h.syncSession).not.toHaveBeenCalled();
  });

  it("fails a run once when its pinned session is gone; a late settlement does not revive it", async () => {
    await seedRun({ startedAt: dispatchedAt });
    h.syncSession.mockRejectedValueOnce(
      new Error("eve stream failed: 404 not found")
    );

    await expect(recoverRoutineRuns(afterWorkflow)).resolves.toMatchObject({
      released: 1,
    });
    const failed = await storedRun();
    expect(failed.status).toBe("failed");

    await fact(1, "delivery.settled", {
      deliveryId,
      outcome: "handled",
      turnId: "routine-turn",
    });
    await fact(2, "turn.settled", {
      outcome: "completed",
      turnId: "routine-turn",
    });
    expect(await observeRoutineRun(runId, afterWorkflow)).toBe("terminal");
    expect(await storedRun()).toMatchObject({
      error: failed.error,
      finishedAt: failed.finishedAt,
      status: "failed",
    });
    await expect(recoverRoutineRuns(afterWorkflow)).resolves.toMatchObject({
      checked: 0,
    });
  });

  it("loses to a terminal recorded while it was proving the session gone", async () => {
    await seedRun({ startedAt: dispatchedAt });
    h.syncSession.mockImplementationOnce(async () => {
      // The workflow records the routine's own completion while the sweep is reading eve.
      await database
        .update(schema.routineRuns)
        .set({ finishedAt: afterWorkflow, status: "succeeded" })
        .where(eq(schema.routineRuns.id, runId));
      throw new Error("eve stream failed: 410 gone");
    });

    expect(await observeRoutineRun(runId, afterWorkflow)).toBe("terminal");
    expect(await storedRun()).toMatchObject({
      error: null,
      status: "succeeded",
    });
  });

  it("does not finish a run on a session other than the one it was admitted to", async () => {
    await seedRun({ startedAt: dispatchedAt });
    h.syncSession.mockImplementationOnce(async () => {
      await database
        .update(schema.routineRuns)
        .set({ sessionId: currentSessionId })
        .where(eq(schema.routineRuns.id, runId));
      throw new Error("eve stream failed: 410 gone");
    });

    expect(await observeRoutineRun(runId, afterWorkflow)).toBe("running");
    expect((await storedRun()).status).toBe("dispatched");
  });

  it("follows the admission session after the bot rotates and never clears the new one", async () => {
    await seedRun({ startedAt: dispatchedAt });
    h.syncSession.mockRejectedValueOnce(
      new Error("eve stream failed: 410 gone")
    );

    await recoverRoutineRuns(afterWorkflow);
    expect(h.readStream).not.toHaveBeenCalledWith(
      expect.anything(),
      currentSessionId,
      expect.anything(),
      expect.anything()
    );
    expect((await storedRun()).sessionId).toBe(sessionId);
    expect((await storedBot()).sessionId).toBe(currentSessionId);
  });

  it("keeps a run whose session cannot be reached for an ordinary reason", async () => {
    await seedRun({ startedAt: dispatchedAt });
    h.syncSession.mockRejectedValueOnce(new Error("fetch failed"));

    await expect(recoverRoutineRuns(afterWorkflow)).resolves.toMatchObject({
      errors: 1,
      released: 0,
    });
    expect((await storedRun()).status).toBe("dispatched");
  });
});

describe("routine monitor against Postgres facts", () => {
  it("waits when delivery awaits input and another turn settles, then succeeds on its own turn", async () => {
    await seedRun();
    await fact(1, "delivery.settled", {
      deliveryId,
      outcome: "awaiting-input",
      turnId: "routine-turn",
    });
    await fact(2, "turn.settled", {
      outcome: "completed",
      turnId: "human-turn",
    });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(false);
    expect((await storedRun()).status).toBe("dispatched");
    expect((await storedMessage()).status).toBe("accepted");

    await fact(3, "turn.settled", {
      outcome: "completed",
      turnId: "routine-turn",
    });
    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect((await storedRun()).status).toBe("succeeded");
    expect((await storedMessage()).status).toBe("accepted");
  });

  it("does not use a same-delivery event from the bot's rotated current session", async () => {
    await seedRun();
    await fact(
      1,
      "delivery.settled",
      { deliveryId, outcome: "handled", turnId: "routine-turn" },
      currentSessionId
    );
    await fact(
      2,
      "turn.settled",
      { outcome: "completed", turnId: "routine-turn" },
      currentSessionId
    );

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(false);
    expect((await storedRun()).status).toBe("dispatched");
    expect((await storedMessage()).status).toBe("accepted");
    expect(h.readStream).toHaveBeenCalledWith(
      expect.anything(),
      sessionId,
      0,
      false
    );
  });

  it("marks a refused delivery failed while retaining the accepted chat message", async () => {
    await seedRun();
    await fact(1, "delivery.settled", { deliveryId, outcome: "refused" });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect((await storedRun()).status).toBe("failed");
    expect((await storedRun()).error).toBe(
      "The routine delivery was not accepted."
    );
    expect((await storedMessage()).status).toBe("accepted");
  });

  it("fails a session that ends without a delivery or turn settlement", async () => {
    await seedRun();
    await database
      .update(schema.bots)
      .set({ historyPending: true, sessionId })
      .where(eq(schema.bots.id, botId));
    await fact(1, "session.ended", { outcome: "failed" });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect((await storedRun()).status).toBe("failed");
    expect((await storedRun()).error).toBe(
      "The bot session ended before this routine could finish. Check the chat."
    );
    expect((await storedMessage()).status).toBe("accepted");
    const [bot] = await database
      .select()
      .from(schema.bots)
      .where(eq(schema.bots.id, botId));
    expect(bot).toMatchObject({ historyPending: false, sessionId: null });
  });

  it("does not retire a replacement session while finishing an old pinned run", async () => {
    await seedRun();
    await fact(1, "session.ended", { outcome: "failed" });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    const [bot] = await database
      .select()
      .from(schema.bots)
      .where(eq(schema.bots.id, botId));
    expect(bot).toMatchObject({ sessionId: currentSessionId });
  });

  it("marks a cancelled turn cancelled while retaining the accepted message", async () => {
    await seedRun();
    await fact(1, "delivery.settled", {
      deliveryId,
      outcome: "handled",
      turnId: "routine-turn",
    });
    await fact(2, "turn.settled", {
      outcome: "cancelled",
      turnId: "routine-turn",
    });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect((await storedRun()).status).toBe("cancelled");
    expect((await storedRun()).error).toBe("The routine was cancelled.");
    expect((await storedMessage()).status).toBe("accepted");
  });

  it("terminalizes a missing pinned session and releases the routine for a future occurrence", async () => {
    await seedRun();
    await database
      .update(schema.bots)
      .set({ historyPending: true, sessionId })
      .where(eq(schema.bots.id, botId));
    h.readStream.mockImplementation(async function* () {
      yield* [];
      throw new Error("eve stream failed: 410 session_stranded");
    });

    expect(await refreshRoutineRun(runId, fixedNow)).toBe(true);
    expect((await storedRun()).status).toBe("failed");
    expect((await storedRun()).error).toBe(
      "The bot session is no longer available; this routine result could not be verified. Check the chat before running it again."
    );
    expect((await storedMessage()).status).toBe("accepted");
    const [bot] = await database
      .select()
      .from(schema.bots)
      .where(eq(schema.bots.id, botId));
    expect(bot).toMatchObject({ historyPending: false, sessionId: null });

    await database.insert(schema.routineRuns).values({
      botId,
      id: "44444444-4444-4444-8444-444444444444",
      prompt: "<routine_execution>\nRead the inbox.",
      routineId,
      scheduledFor: new Date("2026-11-03T12:30:00.000Z"),
      status: "pending",
    });
    await expect(
      database.select().from(schema.routineRuns)
    ).resolves.toHaveLength(2);
  });
});
