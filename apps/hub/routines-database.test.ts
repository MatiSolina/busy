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
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";
import { routineInputSchema } from "./lib/routines/validation";

const syncRoutineSchedule = vi.hoisted(() => vi.fn());
vi.mock("@/lib/routines/schedule", () => ({ syncRoutineSchedule }));

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const routineId = "33333333-3333-4333-8333-333333333333";
const secondRoutineId = "44444444-4444-4444-8444-444444444444";
const firstRunId = "55555555-5555-4555-8555-555555555555";
const secondRunId = "66666666-6666-4666-8666-666666666666";

const at = (value: string) => new Date(value);
const now = at("2026-11-02T12:00:00.000Z"); // 09:00 in America/Argentina/Cordoba

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/routines/store");

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
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
  `);
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
  database = drizzle(client, { schema });

  // The production db() is lazy. Inject one PGlite-backed Drizzle instance so these tests exercise
  // the real SQL, constraints, transactions, partial index and row-level-security metadata.
  vi.doMock("@/lib/db", () => ({
    bots: schema.bots,
    db: () => database,
    routineRuns: schema.routineRuns,
    routineScheduleOutbox: schema.routineScheduleOutbox,
    routines: schema.routines,
  }));
  vi.resetModules();
  store = await import("./lib/routines/store");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  syncRoutineSchedule.mockReset();
  await client.exec(
    "DELETE FROM routine_schedule_outbox; DELETE FROM routine_runs; DELETE FROM routines; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name) VALUES
      ('${alphaId}', 'alpha', 'Alpha'),
      ('${betaId}', 'beta', 'Beta');
  `);
});

function input(id = routineId, patch: Record<string, unknown> = {}) {
  return routineInputSchema.parse({
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    id,
    name: "Morning report",
    prompt: "Read the inbox and summarize it.",
    time: "09:30",
    timeZone: "America/Argentina/Cordoba",
    ...patch,
  });
}

async function insertRun(
  values: Partial<typeof schema.routineRuns.$inferInsert> & {
    id: string;
    routineId: string;
    botId: string;
    scheduledFor: Date;
  }
) {
  await database.insert(schema.routineRuns).values({
    prompt: "<routine_execution>\nrun",
    status: "succeeded",
    ...values,
  });
}

describe("routine persistence invariants", () => {
  it("creates idempotently and rejects an id reused by another bot or payload", async () => {
    const created = await store.createRoutine(alphaId, input());
    const repeated = await store.createRoutine(alphaId, input());
    expect(repeated).toEqual(created);
    expect(await database.select().from(schema.routines)).toHaveLength(1);

    await expect(store.createRoutine(betaId, input())).rejects.toThrow(
      "This request id already belongs to a different routine."
    );
    await expect(
      store.createRoutine(alphaId, input(routineId, { prompt: "Changed" }))
    ).rejects.toThrow(
      "This request id already belongs to a different routine."
    );
  });

  it("keeps the idempotency contract under concurrent creates from two bots", async () => {
    const attempts = await Promise.allSettled([
      store.createRoutine(alphaId, input()),
      store.createRoutine(betaId, input()),
    ]);
    const fulfilled = attempts.filter(
      (attempt) => attempt.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // A unique-key race must surface the same conflict as the sequential idempotency path,
    // rather than leaking a raw database error that the route maps to HTTP 500.
    const [firstRejected] = rejected;
    assert(firstRejected);
    expect(String(firstRejected.reason?.message)).toContain(
      "This request id already belongs to a different routine."
    );
    expect(await database.select().from(schema.routines)).toHaveLength(1);
  });

  it("enforces ownership, then soft-deletes without removing the audit row", async () => {
    await store.createRoutine(alphaId, input());

    await expect(
      store.updateRoutine(betaId, routineId, { name: "Nope" }, now)
    ).rejects.toThrow("Routine not found.");
    await expect(store.deleteRoutine(betaId, routineId, now)).rejects.toThrow(
      "Routine not found."
    );

    await store.updateRoutine(alphaId, routineId, { name: "Updated" }, now);
    await store.deleteRoutine(alphaId, routineId, now);
    expect(await store.listRoutines(alphaId)).toEqual([]);

    const [row] = await database.select().from(schema.routines);
    expect(row).toMatchObject({
      enabled: false,
      id: routineId,
      name: "Updated",
    });
    expect(row?.deletedAt?.toISOString()).toBe(now.toISOString());
  });

  it("cascades routines and runs when the owning bot is deleted", async () => {
    await store.createRoutine(alphaId, input());
    await insertRun({
      botId: alphaId,
      id: firstRunId,
      routineId,
      scheduledFor: at("2026-11-02T12:30:00.000Z"),
    });

    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}';`);
    expect(await database.select().from(schema.routines)).toEqual([]);
    expect(await database.select().from(schema.routineRuns)).toEqual([]);
  });

  it("lists the latest run by scheduled occurrence, not insertion order", async () => {
    await store.createRoutine(alphaId, input());
    await insertRun({
      botId: alphaId,
      id: firstRunId,
      routineId,
      scheduledFor: at("2026-11-02T12:30:00.000Z"),
      status: "succeeded",
    });
    await insertRun({
      botId: alphaId,
      error: "timeout",
      id: secondRunId,
      routineId,
      scheduledFor: at("2026-11-03T12:30:00.000Z"),
      status: "failed",
    });

    const [listed] = await store.listRoutines(alphaId);
    expect(listed?.lastRun).toMatchObject({
      error: "timeout",
      id: secondRunId,
      status: "failed",
    });
    expect(listed?.lastRun?.scheduledFor).toBe("2026-11-03T12:30:00.000Z");
  });

  it("keeps the Vercel schedule in step with every create, edit, pause and delete", async () => {
    await store.createRoutine(alphaId, input());
    expect(syncRoutineSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({
        botId: alphaId,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        enabled: true,
        id: routineId,
        time: "09:30",
        timeZone: "America/Argentina/Cordoba",
      }),
      expect.anything()
    );
    await store.updateRoutine(alphaId, routineId, { time: "10:15" }, now);
    expect(syncRoutineSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, time: "10:15" }),
      expect.anything()
    );
    await store.updateRoutine(alphaId, routineId, { enabled: false }, now);
    expect(syncRoutineSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, time: "10:15" }),
      expect.anything()
    );
    await store.deleteRoutine(alphaId, routineId, now);
    expect(syncRoutineSchedule).toHaveBeenLastCalledWith(
      expect.objectContaining({ deletedAt: now, id: routineId }),
      expect.anything()
    );
    expect(syncRoutineSchedule).toHaveBeenCalledTimes(4);
  });

  it("saves the routine and leaves a pending schedule job when Vercel refuses", async () => {
    syncRoutineSchedule.mockRejectedValueOnce(new Error("schedule_limit"));
    await expect(store.createRoutine(alphaId, input())).resolves.toMatchObject({
      id: routineId,
    });
    expect(await database.select().from(schema.routines)).toHaveLength(1);
    const [job] = await database.select().from(schema.routineScheduleOutbox);
    expect(job).toMatchObject({
      action: "upsert",
      generation: 1,
      lastError: "schedule_sync_failed",
      status: "pending",
    });
  });

  it("bumps the schedule generation with every change, in the routine's transaction", async () => {
    await store.createRoutine(alphaId, input());
    await store.updateRoutine(alphaId, routineId, { name: "Renamed" }, now);
    await store.updateRoutine(alphaId, routineId, { enabled: false }, now);
    await store.deleteRoutine(alphaId, routineId, now);
    const [row] = await database.select().from(schema.routines);
    const [job] = await database.select().from(schema.routineScheduleOutbox);
    expect(row?.scheduleGeneration).toBe(4);
    expect(job).toMatchObject({ action: "delete", generation: 4 });
  });

  it("pauses by cancelling pending runs without a session, but preserves a pinned session", async () => {
    await store.createRoutine(alphaId, input());
    await insertRun({
      botId: alphaId,
      id: firstRunId,
      routineId,
      scheduledFor: at("2026-11-02T12:30:00.000Z"),
      status: "pending",
    });
    await store.updateRoutine(
      alphaId,
      routineId,
      { enabled: false },
      at("2026-11-02T13:00:00.000Z")
    );
    const [cancelled] = await database.select().from(schema.routineRuns);
    expect(cancelled?.status).toBe("cancelled");

    await store.createRoutine(alphaId, input(secondRoutineId));
    await insertRun({
      botId: alphaId,
      id: secondRunId,
      routineId: secondRoutineId,
      scheduledFor: at("2026-11-02T12:30:00.000Z"),
      sessionId: "eve-session",
      status: "pending",
    });
    await store.updateRoutine(
      alphaId,
      secondRoutineId,
      { enabled: false },
      at("2026-11-02T13:00:00.000Z")
    );
    const [pinned] = await database
      .select()
      .from(schema.routineRuns)
      .where(eqRunFor(secondRoutineId));
    expect(pinned).toMatchObject({
      sessionId: "eve-session",
      status: "pending",
    });
  });
});

describe("routine migration invariants", () => {
  it("enables RLS and installs one-active-run protection", async () => {
    const tables = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relkind = 'r' AND relname IN ('routines', 'routine_runs') ORDER BY relname"
    );
    expect(tables.rows).toEqual([
      { relname: "routine_runs", relrowsecurity: true },
      { relname: "routines", relrowsecurity: true },
    ]);

    const indexes = await client.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'routine_runs' ORDER BY indexname"
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain(
      "routine_runs_one_active_idx"
    );
  });

  it("revokes table privileges from the anonymous and authenticated roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["routines", "routine_runs"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          // biome-ignore lint/performance/noAwaitInLoops: each query must observe the prior transaction state.
          const result = await client.query<{ allowed: boolean }>(
            `SELECT has_table_privilege('${role}', 'public.${table}', '${privilege}') AS allowed`
          );
          expect(
            result.rows[0]?.allowed,
            `${role} ${privilege} on ${table}`
          ).toBe(false);
        }
      }
    }
  });

  it("rejects two active runs for one routine even when their scheduled times differ", async () => {
    await store.createRoutine(alphaId, input());
    await insertRun({
      botId: alphaId,
      id: firstRunId,
      routineId,
      scheduledFor: at("2026-11-02T12:30:00.000Z"),
      status: "pending",
    });
    await expect(
      insertRun({
        botId: alphaId,
        id: secondRunId,
        routineId,
        scheduledFor: at("2026-11-03T12:30:00.000Z"),
        status: "dispatched",
      })
    ).rejects.toThrow();
  });
});

// Keep the predicate in one place so the tests never accidentally read a different routine's run.
function eqRunFor(routine: string) {
  return eq(schema.routineRuns.routineId, routine);
}
