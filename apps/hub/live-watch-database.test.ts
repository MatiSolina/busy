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
import { botsMigrations } from "./lib/bots/test-helpers";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const h = vi.hoisted(() => ({
  database: null as unknown,
  sandbox: {
    domain: () => "https://sb-6080.vercel.run",
    expiresAt: undefined as Date | undefined,
    extendTimeout: vi.fn(),
    routes: [{ port: 6080 }],
    runCommand: vi.fn(),
    status: "running",
    stop: vi.fn(),
    update: vi.fn(),
  },
  sandboxGet: vi.fn(),
  syncBot: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  botComputers: schema.botComputers,
  bots: schema.bots,
  db: () => h.database,
  events: schema.events,
}));
vi.mock("@/lib/bots/service", async () => {
  const { eq: equals } = await import("drizzle-orm");
  return {
    getBot: async (botSlug: string) => {
      const [bot] = await (
        h.database as ReturnType<typeof drizzle<typeof schema>>
      )
        .select()
        .from(schema.bots)
        .where(equals(schema.bots.slug, botSlug));
      return bot ?? null;
    },
  };
});
vi.mock("@/lib/chat/store", () => ({ syncBot: h.syncBot }));
vi.mock("@/lib/vercel/client", () => ({ projectId: async () => "prj_bot" }));
vi.mock("@/lib/operation-observability", () => ({
  observeOperation: () => undefined,
  operationErrorCode: () => "error",
}));
vi.mock("@vercel/sandbox", () => {
  class SandboxApiError extends Error {
    response: { status: number };
    constructor(status: number) {
      super(`sandbox api ${status}`);
      this.response = { status };
    }
  }
  return { APIError: SandboxApiError, Sandbox: { get: h.sandboxGet } };
});

const live = await import("./lib/live");
const { APIError } = (await import("@vercel/sandbox")) as unknown as {
  APIError: new (status: number) => Error;
};
const {
  claimShutdown,
  confirmShutdown,
  extendHeldComputer,
  holdComputer,
  markWatching,
  openLiveInSandbox,
  releaseHold,
  releaseShutdown,
  reportSandbox,
  stopIfUnwatched,
} = live;
const { sandboxName } = await import("./lib/sandbox-name");

const botId = "11111111-1111-4111-8111-111111111111";
const slug = "lawyer";
const migration = fileURLToPath(
  new URL("./drizzle/0031_bot_computers.sql", import.meta.url)
);

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  process.env.VERCEL_TEAM_ID = "team_test";
  process.env.VERCEL_TOKEN = "synthetic";
  process.env.SESSION_SECRET = "synthetic-secret";
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
  await client.exec(botsMigrations());
  // The real migration, twice: it must be idempotent.
  await client.exec(readFileSync(migration, "utf8"));
  await client.exec(readFileSync(migration, "utf8"));
  database = drizzle({ client, schema });
  h.database = database;
});

afterAll(async () => {
  await client.close();
});

let line = 0;
async function fact(
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
  ageMs = 0,
  scope?: Record<string, unknown>
) {
  line += 1;
  await database.insert(schema.events).values({
    at: new Date(Date.now() - ageMs),
    botId,
    data: { data, scope, type },
    index: 0,
    line,
    sessionId,
    type,
  });
}

/** Holds the next call of `fn` until the test releases it: forces the interleaving. */
function gate(fn: ReturnType<typeof vi.fn>, then?: () => unknown) {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const opened = new Promise<void>((r) => {
    release = r;
  });
  fn.mockImplementationOnce(async () => {
    entered();
    await opened;
    return then?.();
  });
  return { reached, release };
}

const liveUntil = async () =>
  (
    await database
      .select({ liveUntil: schema.bots.liveUntil })
      .from(schema.bots)
      .where(eq(schema.bots.id, botId))
  )[0]?.liveUntil ?? null;
const computerRow = async () =>
  (
    await database
      .select()
      .from(schema.botComputers)
      .where(eq(schema.botComputers.botId, botId))
  )[0];
const theBot = async () =>
  (
    await database.select().from(schema.bots).where(eq(schema.bots.id, botId))
  )[0] as schema.BotRow;

beforeEach(async () => {
  await database.delete(schema.events);
  await database.delete(schema.botComputers);
  await database.delete(schema.bots);
  await database.insert(schema.bots).values({
    description: "",
    id: botId,
    liveUntil: new Date(Date.now() - 1000),
    name: "Lawyer",
    sessionId: "session-a",
    slug,
    status: "ready",
  });
  h.syncBot.mockReset().mockResolvedValue(undefined);
  h.sandbox.runCommand
    .mockReset()
    .mockResolvedValue({ exitCode: 0, stdout: async () => "" });
  h.sandbox.stop.mockReset().mockResolvedValue(undefined);
  h.sandbox.extendTimeout.mockReset().mockResolvedValue(undefined);
  h.sandbox.status = "running";
  h.sandbox.expiresAt = undefined;
  h.sandboxGet.mockReset().mockResolvedValue(h.sandbox);
});

describe("stopIfUnwatched (H-16)", () => {
  it("stops an idle computer whose lease expired, clears that lease and the claim", async () => {
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).toHaveBeenCalledOnce();
    expect(h.sandboxGet).toHaveBeenCalledWith(
      expect.objectContaining({ name: sandboxName("session-a") })
    );
    expect(await liveUntil()).toBeNull();
    expect((await computerRow())?.claim).toBeNull();
  });

  it("matches a lease Postgres wrote with microseconds", async () => {
    await markWatching(botId, -500);
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).toHaveBeenCalledOnce();
    expect(await liveUntil()).toBeNull();
  });

  it("aborts when a heartbeat extends the lease while it holds the claim", async () => {
    const sync = gate(h.syncBot);
    const watcher = stopIfUnwatched(slug);
    await sync.reached;
    await markWatching(botId, 90_000);
    sync.release();
    await expect(watcher).resolves.toBe(false);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
    expect((await liveUntil())?.getTime()).toBeGreaterThan(Date.now());
    expect((await computerRow())?.claim).toBeNull();
  });

  it("serializes a heartbeat that lands after the commit behind the stop, and keeps watching", async () => {
    const stop = gate(h.sandbox.stop);
    const watcher = stopIfUnwatched(slug);
    await stop.reached;
    expect((await computerRow())?.claimPhase).toBe("stopping");
    await markWatching(botId, 90_000);
    // Opening Live now waits for the stop in flight instead of racing it.
    const liveStarts = () =>
      h.sandbox.runCommand.mock.calls.filter(
        ([command]) => (command as { cmd: string }).cmd === "bash"
      ).length;
    const open = openLiveInSandbox(await theBot(), "control");
    await new Promise((r) => setTimeout(r, 50));
    expect(liveStarts()).toBe(0);
    stop.release();
    await expect(watcher).resolves.toBe(false);
    await expect(open).resolves.toMatchObject({ viewOnly: false });
    expect(liveStarts()).toBe(1);
    expect(defined(h.sandbox.stop.mock.invocationCallOrder[0])).toBeLessThan(
      defined(h.sandbox.runCommand.mock.invocationCallOrder.at(-1))
    );
    expect((await liveUntil())?.getTime()).toBeGreaterThan(Date.now());
  });

  it("never stops session B from a watch that checked session A", async () => {
    const sync = gate(h.syncBot);
    const watcher = stopIfUnwatched(slug);
    await sync.reached;
    await database
      .update(schema.bots)
      .set({ sessionId: "session-b" })
      .where(eq(schema.bots.id, botId));
    sync.release();
    await expect(watcher).resolves.toBe(false);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
  });

  it("keeps the computer for an admitted message no turn took yet", async () => {
    await fact("session-a", "delivery.admitted", { deliveryId: "d1" });
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
  });

  it("keeps it for an orphan turn.started until session.ended is synced", async () => {
    await fact("session-a", "turn.started", { turnId: "t1" }, 60 * 60_000);
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).not.toHaveBeenCalled();

    // The watchdog's re-sync brings the session's end: only that frees it.
    await database
      .update(schema.bots)
      .set({ liveUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.bots.id, botId));
    h.syncBot.mockImplementationOnce(async () => {
      await fact("session-a", "session.ended", { outcome: "failed" });
    });
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).toHaveBeenCalledOnce();
  });

  it("keeps a turn waiting for the user's input past the stale threshold", async () => {
    await fact("session-a", "turn.started", { turnId: "t1" }, 3 * 60 * 60_000);
    await fact("session-a", "turn.paused", { awaiting: [] }, 3 * 60 * 60_000, {
      turnId: "t1",
    });
    await expect(stopIfUnwatched(slug)).resolves.toBe(true);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
  });

  it("leaves a lease that is still running alone", async () => {
    await markWatching(botId, 90_000);
    await expect(stopIfUnwatched(slug)).resolves.toBe(false);
    expect(h.syncBot).not.toHaveBeenCalled();
  });

  it("waits while the bot's own suspend hook holds the claim", async () => {
    const hook = await claimShutdown(botId, "session-a");
    expect(hook).not.toBeNull();
    await expect(stopIfUnwatched(slug)).resolves.toBe(false);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
  });
});

describe("the shutdown claim (H-16/H-17)", () => {
  it("is refused while the lease runs, for another session, or while claimed", async () => {
    await markWatching(botId, 90_000);
    await expect(claimShutdown(botId, "session-a")).resolves.toBeNull();
    await database
      .update(schema.bots)
      .set({ liveUntil: null })
      .where(eq(schema.bots.id, botId));
    await expect(claimShutdown(botId, "session-b")).resolves.toBeNull();
    const first = await claimShutdown(botId, "session-a");
    expect(first).not.toBeNull();
    await expect(claimShutdown(botId, "session-a")).resolves.toBeNull();
  });

  it("is lost when Live opens between the hook's claim and its commit", async () => {
    const claim = defined(await claimShutdown(botId, "session-a"));
    await expect(confirmShutdown(botId, claim, "checking")).resolves.toBe(true);
    await markWatching(botId, 90_000);
    await expect(confirmShutdown(botId, claim, "stopping")).resolves.toBe(
      false
    );
  });

  it("is lost on a new generation even once the lease is over again", async () => {
    const claim = defined(await claimShutdown(botId, "session-a"));
    await markWatching(botId, -500);
    await expect(confirmShutdown(botId, claim, "stopping")).resolves.toBe(
      false
    );
  });

  it("can be taken over once stale, and the old holder can't commit or release it", async () => {
    const old = defined(await claimShutdown(botId, "session-a"));
    await database
      .update(schema.botComputers)
      .set({ claimAt: new Date(Date.now() - live.CLAIM_STALE_MS - 1000) })
      .where(eq(schema.botComputers.botId, botId));
    const fresh = defined(await claimShutdown(botId, "session-a"));
    await expect(confirmShutdown(botId, old, "stopping")).resolves.toBe(false);
    await releaseShutdown(botId, old.claim);
    expect((await computerRow())?.claim).toBe(fresh.claim);
  });

  it("is refused while request_login holds this session, not another one", async () => {
    await holdComputer(await theBot(), "session-a");
    await expect(claimShutdown(botId, "session-a")).resolves.toBeNull();
    await releaseHold(botId, "session-a");
    const claim = defined(await claimShutdown(botId, "session-a"));
    await holdComputer(await theBot(), "session-a");
    await expect(confirmShutdown(botId, claim, "stopping")).resolves.toBe(
      false
    );
    await expect(holdComputer(await theBot(), "session-b")).resolves.toBeNull();
  });
});

describe("request_login's hold (H-17)", () => {
  it("extends a running computer's timeout with the SDK, bounded by the hold", async () => {
    const holdUntil = defined(await holdComputer(await theBot(), "session-a"));
    h.sandbox.expiresAt = new Date(Date.now() + 5 * 60_000);
    await expect(extendHeldComputer(await theBot(), holdUntil)).resolves.toBe(
      30 * 60_000
    );
    expect(h.sandbox.extendTimeout).toHaveBeenCalledWith(30 * 60_000, {
      signal: expect.any(AbortSignal),
    });

    // Near the hold's end it only reaches the end, and never past it.
    const endsSoon = new Date(h.sandbox.expiresAt.getTime() + 60_000);
    await expect(extendHeldComputer(await theBot(), endsSoon)).resolves.toBe(
      60_000
    );
    expect(h.sandbox.extendTimeout).toHaveBeenLastCalledWith(60_000, {
      signal: expect.any(AbortSignal),
    });
    await expect(
      extendHeldComputer(await theBot(), h.sandbox.expiresAt)
    ).resolves.toBe(0);
  });

  it("never extends a computer with plenty of time, or wakes a stopped one", async () => {
    const holdUntil = defined(await holdComputer(await theBot(), "session-a"));
    h.sandbox.expiresAt = new Date(Date.now() + 40 * 60_000);
    await expect(extendHeldComputer(await theBot(), holdUntil)).resolves.toBe(
      0
    );
    h.sandbox.status = "stopped";
    h.sandbox.expiresAt = new Date(Date.now() + 60_000);
    await expect(extendHeldComputer(await theBot(), holdUntil)).resolves.toBe(
      0
    );
    expect(h.sandbox.extendTimeout).not.toHaveBeenCalled();
    expect(h.sandbox.runCommand).not.toHaveBeenCalled();
  });

  it("keeps the watch going and the computer on while held, past the lease", async () => {
    await holdComputer(await theBot(), "session-a");
    h.sandbox.expiresAt = new Date(Date.now() + 60_000);
    await expect(stopIfUnwatched(slug)).resolves.toBe(false);
    expect(h.sandbox.stop).not.toHaveBeenCalled();
    expect(h.sandbox.extendTimeout).toHaveBeenCalledOnce();
    // A failing extension leaves the sandbox's own timeout in charge, still without a stop.
    h.sandbox.extendTimeout.mockRejectedValueOnce(new Error("limit"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(stopIfUnwatched(slug)).resolves.toBe(false);
    warn.mockRestore();
    expect(h.sandbox.stop).not.toHaveBeenCalled();
  });
});

describe("the reported sandbox name (H-18)", () => {
  const real = "eve-sbx-vercel-reported-by-the-bot";

  it("is stored for the current session and used instead of the derived one", async () => {
    await expect(
      reportSandbox(await theBot(), "session-a", real)
    ).resolves.toBe("stored");
    await live.desktopControlInSandbox(await theBot(), "renew", "viewer");
    expect(h.sandboxGet).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: real, projectId: "prj_bot" })
    );
  });

  it("falls back to the derived name for another session's report", async () => {
    await reportSandbox(await theBot(), "session-a", real);
    await database
      .update(schema.bots)
      .set({ sessionId: "session-b" })
      .where(eq(schema.bots.id, botId));
    await expect(
      live.computerName({ id: botId }, "session-b")
    ).resolves.toEqual({ name: sandboxName("session-b"), source: "derived" });
  });

  it("rejects another session's name, one its project can't find, and malformed names", async () => {
    await expect(
      reportSandbox(await theBot(), "session-b", real)
    ).resolves.toBe("session");
    h.sandboxGet.mockRejectedValueOnce(new APIError(404));
    await expect(
      reportSandbox(await theBot(), "session-a", real)
    ).resolves.toBe("missing");
    await expect(
      reportSandbox(await theBot(), "session-a", "../other")
    ).resolves.toBe("invalid");
    expect((await computerRow())?.sandboxName ?? null).toBeNull();
  });
});

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
}
