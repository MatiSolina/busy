import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { decodeJwt } from "jose";
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

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  endSession: vi.fn(),
  isRoutineSchedule: vi.fn(),
  refreshRoutineRun: vi.fn(),
  sendMessage: vi.fn(),
  sessionGone: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/eve/client", () => ({
  createSession: mocks.createSession,
  endSession: mocks.endSession,
  sendMessage: mocks.sendMessage,
}));
vi.mock("@/lib/chat/send", () => ({ sessionGone: mocks.sessionGone }));
vi.mock("@/workflows/routine-run", () => ({ routineRunWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: mocks.start }));
vi.mock("./lib/routines/schedule", () => ({
  isRoutineSchedule: mocks.isRoutineSchedule,
  syncRoutineSchedule: vi.fn(),
}));
vi.mock("./lib/routines/monitor", () => ({
  refreshRoutineRun: mocks.refreshRoutineRun,
}));

const alphaId = "11111111-1111-4111-8111-111111111111";

function deferredVoid() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}
const routineId = "33333333-3333-4333-8333-333333333333";
const runId = "55555555-5555-4555-8555-555555555555";
const V5_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const at = (value: string) => new Date(value);
// 09:30 in America/Argentina/Cordoba (UTC-3), a Monday.
const scheduledAt = at("2026-11-02T12:30:00.000Z");
const now = at("2026-11-02T12:31:00.000Z");
const occurrence = {
  executionId: "schx_first",
  routineId,
  scheduledAt,
  scheduleId: "sch_routine",
};

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let dispatch: typeof import("./lib/routines/dispatch");

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
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      text text NOT NULL,
      file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
      delivery_id text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
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
  vi.doMock("@/lib/db", () => ({
    botSessionOpenings: schema.botSessionOpenings,
    botSessions: schema.botSessions,
    bots: schema.bots,
    db: () => database,
    messages: schema.messages,
    routineRuns: schema.routineRuns,
    routineScheduleOutbox: schema.routineScheduleOutbox,
    routines: schema.routines,
  }));
  vi.stubEnv("BOTS_DOMAIN", "bots.example.test");
  vi.stubEnv("DEV_RELAY_URL", undefined);
  const key = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  }).privateKey.export({ format: "jwk" });
  vi.stubEnv("HUB_SIGNING_KEY", JSON.stringify(key));
  vi.resetModules();
  dispatch = await import("./lib/routines/dispatch");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  vi.resetAllMocks();
  mocks.sessionGone.mockReturnValue(false);
  mocks.createSession.mockResolvedValue("created-session");
  mocks.sendMessage.mockResolvedValue({ deliveryId: "delivery-1" });
  mocks.start.mockResolvedValue(undefined);
  mocks.refreshRoutineRun.mockResolvedValue(false);
  mocks.isRoutineSchedule.mockImplementation(
    async (_routine: unknown, id: string) => id === "sch_routine"
  );
  await client.exec(
    "DELETE FROM bot_session_openings; DELETE FROM bot_sessions; DELETE FROM messages; DELETE FROM routine_runs; DELETE FROM routines; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name, status, session_id) VALUES
      ('${alphaId}', 'alpha', 'Alpha', 'ready', 'main-session');
  `);
  await database.insert(schema.routines).values({
    botId: alphaId,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    id: routineId,
    name: "Morning report",
    prompt: "<routine_execution>\nRun the report.",
    time: "09:30",
    timeZone: "America/Argentina/Cordoba",
  });
});

/** A run recorded by an earlier delivery, for tests that start mid-flight. */
async function insertPendingRun(values: Record<string, unknown> = {}) {
  await database.insert(schema.routineRuns).values({
    botId: alphaId,
    id: runId,
    prompt: "<routine_execution>\nRun the report.",
    routineId,
    scheduledFor: scheduledAt,
    ...values,
  });
}

async function currentRun() {
  const [run] = await database.select().from(schema.routineRuns);
  assert(run);
  return run;
}

describe("routine run ids", () => {
  it("derives one stable UUID per schedule execution", () => {
    const id = dispatch.routineRunId("schx_first");
    expect(dispatch.routineRunId("schx_first")).toBe(id);
    expect(dispatch.routineRunId("schx_second")).not.toBe(id);
    expect(id).toMatch(V5_UUID);
  });
});

describe("routine occurrences", () => {
  const routine = {
    daysOfWeek: [1, 3],
    time: "09:30",
    timeZone: "America/Argentina/Cordoba",
  };

  it("accepts only the routine's own recent wall-clock occurrences", () => {
    expect(dispatch.isRoutineOccurrence(routine, scheduledAt, now)).toBe(true);
    // Tuesday is not selected; 09:31 is not the routine's time.
    expect(
      dispatch.isRoutineOccurrence(
        routine,
        at("2026-11-03T12:30:00.000Z"),
        at("2026-11-03T12:31:00.000Z")
      )
    ).toBe(false);
    expect(
      dispatch.isRoutineOccurrence(routine, at("2026-11-02T12:31:00.000Z"), now)
    ).toBe(false);
    // Too old to run, or claimed for the future.
    expect(
      dispatch.isRoutineOccurrence(
        routine,
        scheduledAt,
        at("2026-11-03T13:00:00.000Z")
      )
    ).toBe(false);
    expect(
      dispatch.isRoutineOccurrence(
        routine,
        scheduledAt,
        at("2026-11-02T12:00:00.000Z")
      )
    ).toBe(false);
  });
});

describe("routine queue consumer", () => {
  it("records one run per execution and sends it once, however often it is delivered", async () => {
    expect(await dispatch.runRoutineOccurrence(occurrence, 1, now)).toBe(
      "dispatched"
    );
    expect(await dispatch.runRoutineOccurrence(occurrence, 2, now)).toBe(
      "dispatched"
    );
    const runs = await database.select().from(schema.routineRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: dispatch.routineRunId("schx_first"),
      scheduledFor: scheduledAt,
      status: "dispatched",
    });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    // Each delivery makes sure a workflow follows the run.
    expect(mocks.start).toHaveBeenCalledTimes(2);
  });

  it("keeps concurrent duplicate deliveries on one run and one eve message id", async () => {
    await Promise.all([
      dispatch.runRoutineOccurrence(occurrence, 1, now),
      dispatch.runRoutineOccurrence(occurrence, 1, now),
    ]);
    expect(await database.select().from(schema.routineRuns)).toHaveLength(1);
    const ids = new Set(
      mocks.sendMessage.mock.calls.map(
        (call) => (call as [unknown, unknown, { id: string }])[2].id
      )
    );
    expect([...ids]).toEqual([dispatch.routineRunId("schx_first")]);
  });

  it("pins the existing session, sends queue policy, and uses the occurrence principal", async () => {
    await dispatch.runRoutineOccurrence(occurrence, 1, now);
    const id = dispatch.routineRunId("schx_first");

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [botCall, sessionId, message] = mocks.sendMessage.mock.calls[0] as [
      { url: string; token: () => Promise<string> },
      string,
      { id: string; text: string; turnPolicy?: string },
    ];
    expect(botCall.url).toBe("https://alpha.bots.example.test");
    expect(sessionId).toBe("main-session");
    expect(message).toMatchObject({ id, turnPolicy: "queue" });
    expect(message.text).toContain("Scheduled for: 2026-11-02T12:30:00.000Z");
    const claims = decodeJwt(await botCall.token());
    expect(claims.sub).toBe(`hub:routine:${id}`);
    expect(claims.aud).toBe("alpha");

    expect(await currentRun()).toMatchObject({
      deliveryId: "delivery-1",
      sessionId: "main-session",
      startedAt: now,
      status: "dispatched",
    });
    const [storedMessage] = await database.select().from(schema.messages);
    expect(storedMessage).toMatchObject({
      deliveryId: "delivery-1",
      id,
      status: "accepted",
    });
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("skips paused routines, deleted routines and occurrences or schedules that are not theirs", async () => {
    expect(
      await dispatch.runRoutineOccurrence(
        { ...occurrence, scheduledAt: at("2026-11-02T12:00:00.000Z") },
        1,
        now
      )
    ).toBe("skipped");
    await database
      .update(schema.routines)
      .set({ enabled: false })
      .where(eq(schema.routines.id, routineId));
    expect(await dispatch.runRoutineOccurrence(occurrence, 1, now)).toBe(
      "skipped"
    );
    expect(
      await dispatch.runRoutineOccurrence(
        { ...occurrence, routineId: runId },
        1,
        now
      )
    ).toBe("skipped");
    await database
      .update(schema.routines)
      .set({ enabled: true })
      .where(eq(schema.routines.id, routineId));
    // A forged message cannot name the routine's schedule.
    expect(
      await dispatch.runRoutineOccurrence(
        { ...occurrence, scheduleId: "sch_forged" },
        1,
        now
      )
    ).toBe("skipped");
    expect(await database.select().from(schema.routineRuns)).toEqual([]);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("skips a new occurrence while the previous run is still active, after refreshing it", async () => {
    await insertPendingRun({
      deliveryId: "old",
      scheduledFor: at("2026-10-28T12:30:00.000Z"),
      sessionId: "main-session",
      status: "dispatched",
    });
    expect(await dispatch.runRoutineOccurrence(occurrence, 1, now)).toBe(
      "skipped"
    );
    expect(mocks.refreshRoutineRun).toHaveBeenCalledWith(runId);
    expect(await database.select().from(schema.routineRuns)).toHaveLength(1);
    const [routine] = await database.select().from(schema.routines);
    expect(routine).toMatchObject({
      lastSkippedAt: now,
      lastSkipReason: "active_run",
      skippedOccurrences: 1,
    });
  });

  it("records that an occurrence was skipped because the previous one waits for the user", async () => {
    await insertPendingRun({
      awaitingInputAt: at("2026-10-28T12:40:00.000Z"),
      deliveryId: "old",
      scheduledFor: at("2026-10-28T12:30:00.000Z"),
      sessionId: "main-session",
      status: "dispatched",
    });
    expect(await dispatch.runRoutineOccurrence(occurrence, 1, now)).toBe(
      "skipped"
    );
    expect(
      await dispatch.runRoutineOccurrence(
        { ...occurrence, executionId: "schx_second" },
        1,
        now
      )
    ).toBe("skipped");
    const [routine] = await database.select().from(schema.routines);
    expect(routine).toMatchObject({
      lastSkipReason: "awaiting_input",
      skippedOccurrences: 2,
    });
    // No new session or message for the skipped occurrences.
    expect(mocks.createSession).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("asks the queue to retry while the bot is not ready, then gives up", async () => {
    await database
      .update(schema.bots)
      .set({ status: "deploying" })
      .where(eq(schema.bots.id, alphaId));
    await expect(
      dispatch.runRoutineOccurrence(occurrence, 1, now)
    ).rejects.toBeInstanceOf(dispatch.RoutineRetryError);
    expect((await currentRun()).status).toBe("pending");
    expect(mocks.sendMessage).not.toHaveBeenCalled();

    expect(
      await dispatch.runRoutineOccurrence(
        occurrence,
        dispatch.MAX_DELIVERIES + 1,
        now
      )
    ).toBe("failed");
    expect(await currentRun()).toMatchObject({
      finishedAt: now,
      status: "failed",
    });
  });

  it("records a generic retryable error and never persists provider details", async () => {
    mocks.sendMessage.mockRejectedValue(
      new Error("provider secret should not persist")
    );
    await expect(
      dispatch.runRoutineOccurrence(occurrence, 1, now)
    ).rejects.toBeInstanceOf(dispatch.RoutineRetryError);
    const row = await currentRun();
    expect(row).toMatchObject({
      error: "Could not reach the bot. Busy will retry this same occurrence.",
      status: "pending",
    });
    expect(row.error).not.toContain("secret");
    expect((await database.select().from(schema.messages))[0]?.status).toBe(
      "pending"
    );
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("fails after the fifth attempt with a generic terminal error", async () => {
    await insertPendingRun({ attempts: 4 });
    mocks.sendMessage.mockRejectedValue(new Error("provider details"));
    expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(false);
    expect(await currentRun()).toMatchObject({
      error:
        "Delivery could not be confirmed after several attempts. Check the chat before running the task again.",
      finishedAt: now,
      status: "failed",
    });
    expect((await database.select().from(schema.messages))[0]?.status).toBe(
      "failed"
    );
  });

  it("keeps the pinned old session when the bot row has rotated", async () => {
    await insertPendingRun({ sessionId: "old-session" });
    await database
      .update(schema.bots)
      .set({ sessionId: "new-session" })
      .where(eq(schema.bots.id, alphaId));
    expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(true);
    expect((mocks.sendMessage.mock.calls[0] as unknown[])[1]).toBe(
      "old-session"
    );
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  describe("a bot without a session (H-43)", () => {
    const withoutSession = () =>
      database
        .update(schema.bots)
        .set({ sessionId: null })
        .where(eq(schema.bots.id, alphaId));
    /** A write to the bot row: resolves "done" unless something holds the database. */
    const probe = () =>
      Promise.race([
        database
          .update(schema.bots)
          .set({ liveUntil: now })
          .where(eq(schema.bots.id, alphaId))
          .then(() => "done"),
        new Promise((resolve) => setTimeout(() => resolve("blocked"), 500)),
      ]);

    it("the probe does detect an open transaction (control)", async () => {
      const release = deferredVoid();
      const holding = database.transaction(async () => {
        await release.wait;
      });
      await expect(probe()).resolves.toBe("blocked");
      release.open();
      await holding;
    });

    it("commits the reservation before eve answers and never holds the bot row across HTTP", async () => {
      await insertPendingRun();
      await withoutSession();
      let duringHttp: unknown;
      mocks.createSession.mockImplementation(async (_call, operationId) => {
        expect(operationId).toBe(`${alphaId}:main:1`);
        duringHttp = await probe();
        return "created-session";
      });
      expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(true);
      expect(duringHttp).toBe("done");
      expect(await currentRun()).toMatchObject({
        sessionId: "created-session",
      });
      const [bot] = await database.select().from(schema.bots);
      expect(bot).toMatchObject({
        historyPending: true,
        sessionId: "created-session",
      });
      const [message] = await database.select().from(schema.messages);
      expect(message).toMatchObject({
        sessionId: "created-session",
        status: "accepted",
      });
    });

    it("uses the session a chat installed while eve answered, and ends its own", async () => {
      await insertPendingRun();
      await withoutSession();
      mocks.endSession.mockResolvedValue(true);
      mocks.createSession.mockImplementation(async () => {
        await database
          .update(schema.bots)
          .set({ sessionId: "chat-session" })
          .where(eq(schema.bots.id, alphaId));
        return "routine-session";
      });
      expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(true);
      expect((mocks.sendMessage.mock.calls[0] as unknown[])[1]).toBe(
        "chat-session"
      );
      expect((mocks.endSession.mock.calls[0] as unknown[])[1]).toBe(
        "routine-session"
      );
      const [bot] = await database.select().from(schema.bots);
      expect(bot?.sessionId).toBe("chat-session");
    });

    it("two deliveries of the occurrence open one session", async () => {
      await insertPendingRun();
      await withoutSession();
      const eve = deferredVoid();
      mocks.createSession.mockImplementation(async () => {
        await eve.wait;
        return "created-session";
      });
      const first = dispatch.dispatchRoutineRun(runId, now);
      await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalled());
      const second = dispatch.dispatchRoutineRun(runId, now);
      await new Promise((resolve) => setTimeout(resolve, 400));
      eve.open();
      await Promise.allSettled([first, second]);
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
      expect(
        new Set(
          mocks.sendMessage.mock.calls.map((call) => (call as unknown[])[1])
        )
      ).toEqual(new Set(["created-session"]));
    });

    it("after a crash past createSession, the next delivery repeats the same operation id", async () => {
      await insertPendingRun();
      await withoutSession();
      // The crashed worker's reservation, expired.
      await database.insert(schema.botSessionOpenings).values({
        botId: alphaId,
        generation: 1,
        leaseUntil: new Date(Date.now() - 1000),
        operationId: `${alphaId}:main:1`,
        token: "99999999-9999-4999-8999-999999999999",
      });
      expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(true);
      expect(mocks.createSession).toHaveBeenCalledTimes(1);
      expect((mocks.createSession.mock.calls[0] as unknown[])[1]).toBe(
        `${alphaId}:main:1`
      );
    });
  });

  it("cancels an unpinned run when its routine was disabled", async () => {
    await insertPendingRun();
    await database
      .update(schema.routines)
      .set({ enabled: false })
      .where(eq(schema.routines.id, routineId));
    expect(await dispatch.dispatchRoutineRun(runId, now)).toBe(false);
    expect((await currentRun()).status).toBe("cancelled");
  });
});
