import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { SchedulesApiError } from "@vercel/schedules";
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

interface Remote {
  cron: string;
  state: "active" | "paused";
  timezone: string;
}

/**
 * An in-memory Vercel Schedules API. Every call records whether a Postgres transaction was open,
 * how many calls overlapped, and may wait on a test-controlled barrier.
 */
const fake = vi.hoisted(() => {
  const state = {
    barrier: null as null | {
      arrived: () => void;
      release: Promise<void>;
    },
    calls: [] as string[],
    failNext: null as null | Error,
    inFlight: 0,
    maxInFlight: 0,
    remote: new Map<string, Remote>(),
    transactionsOpen: 0,
    violations: 0,
  };
  const key = (id: { name: string; namespace: string }) =>
    `${id.namespace}/${id.name}`;
  async function call<T>(name: string, run: () => T): Promise<T> {
    if (state.transactionsOpen > 0) {
      state.violations += 1;
    }
    state.calls.push(name);
    state.inFlight += 1;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      const { barrier } = state;
      if (barrier) {
        state.barrier = null;
        barrier.arrived();
        await barrier.release;
      }
      const failure = state.failNext;
      if (failure) {
        state.failNext = null;
        throw failure;
      }
      return run();
    } finally {
      state.inFlight -= 1;
    }
  }
  return { call, key, state };
});

vi.mock("@vercel/schedules", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vercel/schedules")>();
  const missing = () =>
    new original.SchedulesApiError(404, "missing", { code: "not_found" });
  interface Id {
    name: string;
    namespace: string;
  }
  type Spec = Id & { expression: { cron: string }; timezone: string };
  const Schedules = {
    create: (spec: Spec) =>
      fake.call("create", () => {
        fake.state.remote.set(fake.key(spec), {
          cron: spec.expression.cron,
          state: "active",
          timezone: spec.timezone,
        });
        return { state: "active" };
      }),
    delete: (id: Id) =>
      fake.call("delete", () => {
        if (!fake.state.remote.delete(fake.key(id))) {
          throw missing();
        }
      }),
    disable: (id: Id) =>
      fake.call("disable", () => {
        const remote = fake.state.remote.get(fake.key(id));
        if (!remote) {
          throw missing();
        }
        remote.state = "paused";
        return remote;
      }),
    enable: (id: Id) =>
      fake.call("enable", () => {
        const remote = fake.state.remote.get(fake.key(id));
        if (!remote) {
          throw missing();
        }
        remote.state = "active";
        return remote;
      }),
    update: (spec: Spec) =>
      fake.call("update", () => {
        const remote = fake.state.remote.get(fake.key(spec));
        if (!remote) {
          throw missing();
        }
        remote.cron = spec.expression.cron;
        remote.timezone = spec.timezone;
        return { state: remote.state };
      }),
  };
  return { ...original, Schedules };
});

const botId = "11111111-1111-4111-8111-111111111111";
const routineId = "33333333-3333-4333-8333-333333333333";
const remoteKey = `bot-${botId}/routine-${routineId}`;

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/routines/store");
let outbox: typeof import("./lib/routines/outbox");

function sql(file: string) {
  return readFileSync(
    fileURLToPath(new URL(`./drizzle/${file}`, import.meta.url)),
    "utf8"
  );
}

beforeAll(async () => {
  vi.stubEnv("VERCEL_SCHEDULE_BASE_URL", "http://schedules.test");
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL DEFAULT 'Bot',
      avatar text, description text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'model/example', billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'ready',
      deployment_id text, url text, session_id text, live_until timestamptz,
      history_pending boolean NOT NULL DEFAULT false, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.exec(sql("0011_routines.sql"));
  await client.exec(sql("0024_routine_next_run_nullable.sql"));
  // Applied twice: the migration must be re-runnable.
  await client.exec(sql("0030_routine_recovery_schedule_outbox.sql"));
  await client.exec(sql("0030_routine_recovery_schedule_outbox.sql"));
  database = drizzle(client, { schema });
  // Count open transactions so every Schedules call can prove it ran outside one.
  const tracked = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") {
        return Reflect.get(target, property, receiver);
      }
      return async (...args: Parameters<typeof database.transaction>) => {
        fake.state.transactionsOpen += 1;
        try {
          return await target.transaction(...args);
        } finally {
          fake.state.transactionsOpen -= 1;
        }
      };
    },
  });
  vi.doMock("@/lib/db", () => ({
    bots: schema.bots,
    db: () => tracked,
    routineRuns: schema.routineRuns,
    routineScheduleOutbox: schema.routineScheduleOutbox,
    routines: schema.routines,
  }));
  vi.resetModules();
  store = await import("./lib/routines/store");
  outbox = await import("./lib/routines/outbox");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  Object.assign(fake.state, {
    barrier: null,
    calls: [],
    failNext: null,
    inFlight: 0,
    maxInFlight: 0,
    transactionsOpen: 0,
    violations: 0,
  });
  fake.state.remote.clear();
  await client.exec(
    "DELETE FROM routine_schedule_outbox; DELETE FROM routine_runs; DELETE FROM routines; DELETE FROM bots;"
  );
  await client.exec(
    `INSERT INTO bots (id, slug, name) VALUES ('${botId}', 'alpha', 'Alpha');`
  );
});

function input() {
  return routineInputSchema.parse({
    daysOfWeek: [1, 3],
    id: routineId,
    name: "Morning report",
    prompt: "Read the inbox and summarize it.",
    time: "09:30",
    timeZone: "America/Argentina/Cordoba",
  });
}

async function job() {
  const [row] = await database
    .select()
    .from(schema.routineScheduleOutbox)
    .where(eq(schema.routineScheduleOutbox.routineId, routineId));
  return row;
}

function hold() {
  let arrived: () => void = () => undefined;
  let release: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  fake.state.barrier = { arrived, release: opened };
  return { reached, release };
}

const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("routine schedule outbox", () => {
  it("keeps the routine when Vercel fails and retries the same job with backoff", async () => {
    fake.state.failNext = new SchedulesApiError(503, "secret detail", {
      code: "service_unavailable",
    });
    await store.createRoutine(botId, input());

    expect(await database.select().from(schema.routines)).toHaveLength(1);
    const failed = await job();
    expect(failed).toMatchObject({
      action: "upsert",
      attempts: 1,
      generation: 1,
      lastError: "schedules_service_unavailable",
      leaseToken: null,
      status: "pending",
    });
    expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(fake.state.remote.size).toBe(0);

    // Not due yet: the cron leaves it alone, then applies it once the backoff passed.
    await expect(
      outbox.processRoutineScheduleOutbox({ now: new Date() })
    ).resolves.toEqual({ applied: 0, failed: 0, superseded: 0 });
    await expect(
      outbox.processRoutineScheduleOutbox({ now: later(1) })
    ).resolves.toMatchObject({ applied: 1 });
    expect(fake.state.remote.get(remoteKey)).toMatchObject({
      cron: "30 9 * * 1,3",
      state: "active",
    });
    expect(await job()).toMatchObject({ attempts: 0, status: "applied" });
  });

  it("finds a job whose process died after the commit, and routines saved before the outbox", async () => {
    // Committed with its job, but the process stopped before calling Vercel.
    await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.routines)
        .values({ ...input(), botId })
        .returning();
      if (row) {
        await outbox.enqueueRoutineSchedule(
          tx as unknown as Parameters<typeof outbox.enqueueRoutineSchedule>[0],
          row,
          new Date()
        );
      }
    });
    // Saved by code that predates the outbox: no job at all.
    const legacyId = "44444444-4444-4444-8444-444444444444";
    await database
      .insert(schema.routines)
      .values({ ...input(), botId, enabled: false, id: legacyId });

    await expect(outbox.reconcileRoutineSchedules(later(1))).resolves.toEqual({
      applied: 2,
      failed: 0,
      superseded: 0,
    });
    expect(fake.state.remote.get(remoteKey)?.state).toBe("active");
    expect(
      fake.state.remote.get(`bot-${botId}/routine-${legacyId}`)?.state
    ).toBe("paused");
  });

  it("never lets an older enable land after a newer disable", async () => {
    await store.createRoutine(botId, input());
    expect(fake.state.remote.get(remoteKey)?.state).toBe("active");
    await store.updateRoutine(botId, routineId, { enabled: false });
    expect(fake.state.remote.get(remoteKey)?.state).toBe("paused");

    // Resume (generation 3) is in flight at Vercel when a pause (generation 4) commits.
    const held = hold();
    const resuming = store.updateRoutine(botId, routineId, { enabled: true });
    await held.reached;
    await store.updateRoutine(botId, routineId, { enabled: false });
    // The pause's own post-commit pass could not claim the leased job: no overlapping call.
    expect(fake.state.maxInFlight).toBe(1);
    held.release();
    await resuming;

    expect(await job()).toMatchObject({ generation: 4, status: "pending" });
    await outbox.processRoutineScheduleOutbox({ now: later(1) });
    expect(await job()).toMatchObject({
      action: "disable",
      generation: 4,
      status: "applied",
    });
    expect(fake.state.remote.get(remoteKey)?.state).toBe("paused");
    expect(fake.state.violations).toBe(0);
  });

  it("does not recreate a schedule after a newer delete", async () => {
    // The create's call is held at Vercel while the routine is deleted.
    const held = hold();
    const creating = store.createRoutine(botId, input());
    await held.reached;
    await store.deleteRoutine(botId, routineId);
    held.release();
    await creating;

    expect(await job()).toMatchObject({
      action: "delete",
      generation: 2,
      status: "pending",
    });
    await outbox.processRoutineScheduleOutbox({ now: later(1) });
    expect(fake.state.remote.has(remoteKey)).toBe(false);
    expect(await job()).toMatchObject({ status: "applied" });

    // Later passes keep it deleted: a missing schedule counts as deleted, and nothing creates it.
    fake.state.calls.length = 0;
    await outbox.reconcileRoutineSchedules(later(2));
    expect(fake.state.calls).toEqual([]);
    expect(fake.state.remote.has(remoteKey)).toBe(false);
  });

  it("treats a delete Vercel does not know as done", async () => {
    await store.createRoutine(botId, input());
    fake.state.remote.clear();
    await store.deleteRoutine(botId, routineId);
    expect(fake.state.calls.at(-1)).toBe("delete");
    expect(await job()).toMatchObject({
      action: "delete",
      lastError: null,
      status: "applied",
    });
  });

  it("lets an expired lease be taken over without the old worker claiming success", async () => {
    await database.transaction(async (tx) => {
      const [row] = await tx
        .insert(schema.routines)
        .values({ ...input(), botId })
        .returning();
      if (row) {
        await outbox.enqueueRoutineSchedule(
          tx as unknown as Parameters<typeof outbox.enqueueRoutineSchedule>[0],
          row,
          new Date()
        );
      }
    });
    const held = hold();
    const stale = outbox.processRoutineScheduleOutbox({ now: new Date() });
    await held.reached;
    const firstLease = (await job())?.leaseToken;

    // Within the lease nobody else claims it; after it expires a new worker does.
    await expect(
      outbox.processRoutineScheduleOutbox({ now: later(1) })
    ).resolves.toMatchObject({ applied: 0 });
    await expect(
      outbox.processRoutineScheduleOutbox({ now: later(20) })
    ).resolves.toMatchObject({ applied: 1 });
    const takenOver = await job();
    expect(takenOver).toMatchObject({ leaseToken: null, status: "applied" });

    held.release();
    await expect(stale).resolves.toEqual({
      applied: 0,
      failed: 0,
      superseded: 1,
    });
    expect(firstLease).not.toBeNull();
    expect(await job()).toEqual(takenOver);
  });

  it("deletes the schedule of a routine removed with its bot, then forgets the job", async () => {
    await store.createRoutine(botId, input());
    await client.exec(`DELETE FROM bots WHERE id = '${botId}';`);
    expect(await database.select().from(schema.routines)).toEqual([]);
    expect(await job()).toBeDefined(); // no foreign key: the job survives the cascade

    await outbox.reconcileRoutineSchedules(later(1));
    expect(fake.state.remote.has(remoteKey)).toBe(false);
    await outbox.reconcileRoutineSchedules(later(2));
    expect(await job()).toBeUndefined();
  });

  it("never calls Schedules while a Postgres transaction is open", async () => {
    await store.createRoutine(botId, input());
    await store.updateRoutine(botId, routineId, { time: "10:15" });
    await store.updateRoutine(botId, routineId, { enabled: false });
    await store.deleteRoutine(botId, routineId);
    await outbox.reconcileRoutineSchedules(later(1));
    expect(fake.state.calls.length).toBeGreaterThan(4);
    expect(fake.state.violations).toBe(0);
  });
});
