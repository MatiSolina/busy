import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { deployMigration } from "./lib/bots/test-helpers";
import {
  bots,
  firesideCommands,
  firesideRunners,
  firesides,
  memories,
} from "./lib/db/schema";
import { activate, bot, initialState } from "./lib/firesides/test-helpers";

const schema = {
  bots,
  firesideCommands,
  firesideRunners,
  firesides,
  memories,
};
const workflowStart = vi.hoisted(() => vi.fn());
vi.mock("workflow/api", () => ({ start: workflowStart }));
vi.mock("./workflows/fireside", () => ({ firesideWorkflow: "fireside" }));
let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/firesides/store");
let auth: typeof import("./lib/firesides/auth");
const getAiSettings = vi.hoisted(() => vi.fn());
vi.mock("./lib/ai/settings", () => ({ getAiSettings }));
vi.mock("./lib/chat/send", () => ({
  recentHistory: async () => "User: Should we ship?",
}));

vi.mock("./lib/firesides/compatibility", () => ({
  requireFiresideRuntime: vi.fn(async () => undefined),
}));
const native = vi.hoisted(() => ({
  computer: vi.fn(),
  createSession: vi.fn(),
  endSession: vi.fn(),
  readStream: vi.fn(),
  sendMessage: vi.fn(),
}));
vi.mock("./lib/eve/client", () => ({ ...native }));
vi.mock("./lib/firesides/transport", () => ({
  firesideCall: (_id: string, participant: { slug: string }) => ({
    slug: participant.slug,
  }),
  firesideComputer: native.computer,
}));
let runtime: typeof import("./lib/firesides/runtime");
let schedule: typeof import("./lib/firesides/schedule");
let runner: typeof import("./lib/firesides/runner");
const stream = new Map<
  string,
  { line: number; record: Record<string, unknown> }[]
>();
vi.mock("./lib/bot-auth", () => ({
  botFromRequest: () => Promise.resolve({ slug: "guest" }),
}));
beforeAll(async () => {
  client = new PGlite();
  await client.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE TABLE bots (id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, avatar text, description text NOT NULL DEFAULT '', instructions text NOT NULL DEFAULT '', model text NOT NULL, billing text NOT NULL, fast boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'ready', deployment_id text, url text, session_id text, live_until timestamptz, history_pending boolean NOT NULL DEFAULT false, deletion_state text, deletion_token uuid, deletion_requested_at timestamptz, deletion_attempts integer NOT NULL DEFAULT 0, deletion_next_attempt_at timestamptz, deletion_last_error text, deletion_project_id text, error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE memories (bot_slug text PRIMARY KEY, content text NOT NULL, version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());`);
  // Bots columns added by later SQL migrations (bots predates drizzle/).
  await client.exec(deployMigration());
  for (const migration of ["0022_firesides.sql", "0034_fireside_runners.sql"]) {
    // biome-ignore lint/performance/noAwaitInLoops: migrations apply in order.
    await client.exec(
      readFileSync(new URL(`./drizzle/${migration}`, import.meta.url), "utf8")
    );
  }
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({ ...schema, db: () => database }));
  store = await import("./lib/firesides/store");
  auth = await import("./lib/firesides/auth");
  runtime = await import("./lib/firesides/runtime");
  schedule = await import("./lib/firesides/schedule");
  runner = await import("./lib/firesides/runner");
});
beforeEach(async () => {
  await client.exec(
    "DELETE FROM fireside_runners; DELETE FROM fireside_commands; DELETE FROM firesides; DELETE FROM bots; DELETE FROM memories;"
  );
  await database
    .insert(bots)
    .values([bot(), bot("guest", "grok/grok-4.7", "grok")]);
  getAiSettings.mockResolvedValue({
    provider: "chatgpt",
    providers: [
      {
        id: "chatgpt",
        models: [{ id: "chatgpt/gpt-6", label: "GPT" }],
        status: "available",
      },
      {
        id: "grok",
        models: [{ id: "grok/grok-4.7", label: "Grok" }],
        status: "available",
      },
    ],
  });
  vi.stubEnv("SESSION_SECRET", "test-secret");
  stream.clear();
  native.createSession
    .mockReset()
    .mockImplementation(
      async (_call, operation: string) => `isolated:${operation}`
    );
  native.sendMessage
    .mockReset()
    .mockImplementation((_call, session: string, message: { id: string }) => {
      const records = stream.get(session) ?? [];
      const line = records.length;
      records.push({
        line,
        record: {
          facts: [
            { data: { turnId: message.id }, type: "turn.started" },
            {
              data: {
                kind: "text",
                partId: message.id,
                phase: "reply",
                value: `Opinion from ${session}`,
              },
              type: "content.completed",
            },
            {
              data: {
                outcome: "completed",
                reply: [message.id],
                turnId: message.id,
              },
              type: "turn.settled",
            },
          ],
        },
      });
      stream.set(session, records);
      return Promise.resolve({ deliveryId: message.id });
    });
  native.endSession.mockReset().mockImplementation((_call, session: string) => {
    const records = stream.get(session) ?? [];
    records.push({
      line: records.length,
      record: {
        facts: [{ data: { outcome: "completed" }, type: "session.ended" }],
      },
    });
    stream.set(session, records);
    return Promise.resolve(false);
  });
  native.readStream.mockReset().mockImplementation(async function* (
    _call,
    session: string,
    cursor: number
  ) {
    yield* (stream.get(session) ?? []).filter(
      (record) => record.line >= cursor
    );
  });
  native.computer.mockReset().mockResolvedValue({ ok: true });
  workflowStart
    .mockReset()
    .mockImplementation(async () => ({ runId: `wrun_${randomUUID()}` }));
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});
/** Moves the clock past any cancellation backoff; backoff only spaces retries. */
function laterThanBackoff() {
  vi.useFakeTimers({ now: Date.now() + 61_000, toFake: ["Date"] });
}
async function insert() {
  const state = initialState();
  const [row] = await database
    .insert(firesides)
    .values({
      botId: bot().id,
      id: randomUUID(),
      originId: randomUUID(),
      state,
      status: state.status,
    })
    .returning();
  return row;
}

describe("fireside persistence and authority", () => {
  it("applies the real migration with RLS and no public table access", async () => {
    const result = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('firesides', 'fireside_commands')"
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.relrowsecurity)).toBe(true);
    const grants = await client.query<{ allowed: boolean }>(
      "SELECT has_table_privilege('anon', 'firesides', 'SELECT') AS allowed"
    );
    expect(grants.rows[0]?.allowed).toBe(false);
  });
  it("creates once for duplicate invocations, freezes identities and leaves the principal unchanged", async () => {
    const origin = randomUUID();
    const first = await store.createFireside(bot(), origin);
    const duplicate = await store.createFireside(bot(), origin);
    const another = await store.createFireside(bot(), randomUUID());
    expect(duplicate.id).toBe(first.id);
    expect(another.id).toBe(first.id);
    expect(first.state.participants.guest).toMatchObject({
      billing: "grok",
      slug: "guest",
      temporary: false,
    });
    expect(
      (await database.select().from(bots).where(eq(bots.id, bot().id)))[0]
    ).toMatchObject({ model: "chatgpt/gpt-6", sessionId: "normal-session" });
    getAiSettings.mockRejectedValue(new Error("Disconnected"));
    expect((await store.createFireside(bot(), origin)).id).toBe(first.id);
  });
  it("uses an ephemeral full participant when the second model has no permanent bot", async () => {
    await database.delete(bots).where(eq(bots.slug, "guest"));
    const fire = await store.createFireside(bot(), randomUUID());
    expect(fire.state.participants.guest).toMatchObject({
      billing: "grok",
      model: "grok/grok-4.7",
      slug: "primary",
      temporary: true,
    });
    expect(fire.state.participants.guest.id).not.toBe(
      fire.state.participants.primary.id
    );
    expect(await database.select().from(bots)).toHaveLength(1);
  });
  it("deduplicates a command despite JSONB property order and rejects reused ids with a different body", async () => {
    const fire = await insert();
    const command = {
      id: randomUUID(),
      kind: "intervene" as const,
      revision: 1,
      text: "Cost matters",
    };
    await store.commandFireside(fire.id, command);
    const repeated = await store.commandFireside(fire.id, command);
    expect(repeated?.state.messages).toHaveLength(1);
    await expect(
      store.commandFireside(fire.id, { ...command, text: "Different" })
    ).rejects.toThrow("already used");
    expect(await database.select().from(firesideCommands)).toHaveLength(1);
  });
  it("fences stale leases and stale commands while making close summaries immediately durable", async () => {
    const fire = await insert();
    const claim = await store.claimFireside(fire.id);
    expect(await store.claimFireside(fire.id)).toBeNull();
    expect(
      await store.updateFireside(
        fire.id,
        (state) => {
          state.error = "should not save";
        },
        randomUUID()
      )
    ).toBeNull();
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: 1,
    });
    expect((await store.firesideContext(bot().id))[0]?.summary).toContain(
      "did not complete"
    );
    expect(
      store.publicFireside((await store.getFireside(fire.id)) ?? fire)
        .participants.primary
    ).not.toHaveProperty("memory");
    if (claim) {
      await store.releaseFireside(fire.id, claim.token);
    }
  });
  it("rejects another bot's origin id and reopening an old fireside while a new one is open", async () => {
    const first = await store.createFireside(bot(), randomUUID());
    await expect(
      store.createFireside(bot("guest"), first.originId)
    ).rejects.toThrow("another conversation");
    await store.updateFireside(first.id, (state) => {
      state.status = "closed";
    });
    await store.createFireside(bot(), randomUUID());
    await expect(
      store.commandFireside(first.id, {
        id: randomUUID(),
        kind: "continue",
        revision: 1,
      })
    ).rejects.toThrow("Another fireside");
  });
  it("limits inference atomically and rejects an old revision or session after intervention", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => activate(state, "guest"));
    const p = fire.state.participants.guest;
    const count = () => auth.countModelRequest(fire.id, p.id, "fire-guest", 1);
    const result = await Promise.all(Array.from({ length: 34 }, count));
    expect(result.filter(Boolean)).toHaveLength(32);
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "intervene",
      revision: 1,
      text: "New direction",
    });
    expect(await count()).toBe(false);
    await store.updateFireside(fire.id, (state) => activate(state, "guest"));
    expect(await auth.countModelRequest(fire.id, p.id, "old-session", 2)).toBe(
      false
    );
    expect(await auth.countModelRequest(fire.id, p.id, "fire-guest", 2)).toBe(
      true
    );
  });
  it("does not recover idle paused rooms and never exposes native runtime provenance in public messages", async () => {
    const fire = await insert();
    const saved = await store.updateFireside(fire.id, (state) => {
      state.status = "paused";
      state.messages.push({
        at: "now",
        id: "reply",
        runtime: { calls: [], sessionId: "private-session" },
        speaker: "guest",
        text: "Public opinion",
      });
    });
    expect(await store.pendingFiresides()).toHaveLength(0);
    expect(saved && store.publicFireside(saved).messages[0]).not.toHaveProperty(
      "runtime"
    );
    await store.updateFireside(fire.id, (state) => {
      state.cancelSessions.push("fire-guest");
    });
    expect(await store.pendingFiresides()).toHaveLength(1);
  });

  it("starts with missing memory, saves privately, and fences a write overtaken by intervention", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => {
      activate(state, "guest");
      state.participants.guest.memory = "";
    });
    const { GET, PUT } = await import("./app/api/bot/firesides/memory/route");
    const participant = fire.state.participants.guest;
    const headers = {
      "x-busy-fireside-id": fire.id,
      "x-busy-fireside-participant": participant.id,
      "x-busy-fireside-proof": auth.participantProof(participant.id),
      "x-busy-fireside-session": "fire-guest",
    };
    expect(
      (await GET(new Request("https://hub/api", { headers }))).status
    ).toBe(404);
    const content =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: Fire-only memory\n";
    const write = new Request("https://hub/api", {
      body: JSON.stringify({ content, expectedVersion: null }),
      headers,
      method: "PUT",
    });
    expect((await PUT(write)).status).toBe(200);
    expect(
      (await store.getFireside(fire.id))?.state.participants.guest.memory
    ).toBe(content);
    expect(await database.select().from(memories)).toHaveLength(0);
    const stale = new Request("https://hub/api", { headers, method: "PUT" });
    vi.spyOn(stale, "json").mockImplementation(async () => {
      await store.commandFireside(fire.id, {
        id: randomUUID(),
        kind: "intervene",
        revision: 1,
        text: "New direction",
      });
      return { content: "stale write", expectedVersion: 1 };
    });
    expect((await PUT(stale)).status).toBe(409);
    expect(
      (await store.getFireside(fire.id))?.state.participants.guest.memory
    ).toBe(content);
  });

  it("preserves ordinary chat context loading before the additive migration exists", async () => {
    await client.exec(
      "ALTER TABLE firesides RENAME TO pending_fireside_migration"
    );
    try {
      expect(await store.firesideContext(bot().id)).toEqual([]);
    } finally {
      await client.exec(
        "ALTER TABLE pending_fireside_migration RENAME TO firesides"
      );
    }
  });

  it("binds runtime access to the deployment, session, participant and unguessable proof", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => activate(state, "guest"));
    const p = fire.state.participants.guest;
    const headers = {
      "x-busy-fireside-id": fire.id,
      "x-busy-fireside-participant": p.id,
      "x-busy-fireside-proof": auth.participantProof(p.id),
      "x-busy-fireside-session": "fire-guest",
    };
    expect(
      await auth.runtimeParticipant(
        new Request("https://hub/api", { headers }),
        "guest"
      )
    ).not.toBeNull();
    expect(
      await auth.runtimeParticipant(
        new Request("https://hub/api", { headers }),
        "primary"
      )
    ).toBeNull();
    expect(
      await auth.runtimeParticipant(
        new Request("https://hub/api", {
          headers: { ...headers, "x-busy-fireside-proof": "0".repeat(64) },
        }),
        "guest"
      )
    ).toBeNull();
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: 1,
    });
    expect(
      await auth.runtimeParticipant(
        new Request("https://hub/api", { headers }),
        "guest"
      )
    ).toBeNull();
  });
});

async function ticks(id: string, count = 10) {
  for (let i = 0; i < count; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each tick consumes the previous durable state.
    await runtime.firesideTick(id);
  }
}
describe("durable fireside coordinator", () => {
  it("runs exactly two complete sessions without a browser and carries the first opinion into the second", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => {
      for (const p of Object.values(state.participants)) {
        p.sessionId = null;
      }
    });
    await ticks(fire.id);
    const waiting = await store.getFireside(fire.id);
    expect(waiting?.status).toBe("waiting");
    expect(waiting?.state.messages).toHaveLength(2);
    expect(native.sendMessage).toHaveBeenCalledTimes(2);
    expect(native.sendMessage.mock.calls[1]?.[2].text).toContain(
      waiting?.state.messages[0]?.text
    );
    expect(
      native.createSession.mock.calls.every((call) =>
        String(call[1]).startsWith(`fireside:${fire.id}:`)
      )
    ).toBe(true);
    expect(
      native.sendMessage.mock.calls.every(
        (call) => call[1] !== "normal-session"
      )
    ).toBe(true);
    await ticks(fire.id);
    expect(native.sendMessage).toHaveBeenCalledTimes(2);
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "continue",
      revision: waiting?.state.revision ?? 0,
    });
    await ticks(fire.id);
    expect(native.sendMessage).toHaveBeenCalledTimes(4);
    expect(native.createSession).toHaveBeenCalledTimes(2);
  });
  it("ends only isolated sessions, confirms the end, then stops their computers", async () => {
    const fire = await insert();
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: 1,
    });
    native.readStream.mockImplementation(async function* () {
      yield* [];
    });
    await runtime.firesideTick(fire.id);
    expect((await store.getFireside(fire.id))?.status).toBe("closing");
    expect(native.computer).not.toHaveBeenCalled();
    native.endSession.mockResolvedValue(true);
    native.computer.mockRejectedValueOnce(
      new Error("temporary sandbox failure")
    );
    laterThanBackoff();
    await runtime.firesideTick(fire.id);
    expect((await store.getFireside(fire.id))?.state.error).toContain(
      "Still stopping"
    );
    for (let i = 0; i < 5; i += 1) {
      laterThanBackoff();
      // biome-ignore lint/performance/noAwaitInLoops: each tick consumes the previous durable state.
      await runtime.firesideTick(fire.id);
    }
    const closed = await store.getFireside(fire.id);
    expect(closed?.status).toBe("closed");
    expect(closed?.state.error).toBeNull();
    expect(
      native.endSession.mock.calls.every((call) =>
        String(call[1]).startsWith("fire-")
      )
    ).toBe(true);
    expect(native.computer).toHaveBeenCalledTimes(3);
    expect(native.sendMessage).not.toHaveBeenCalled();
  });
  it("recovers a session create with an unknown outcome and closes it without sending a message", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => {
      state.participants.guest.sessionId = null;
    });
    native.createSession.mockRejectedValueOnce(new Error("connection lost"));
    await runtime.firesideTick(fire.id);
    const failed = await store.getFireside(fire.id);
    expect(failed?.state.participants.guest.allocating).toBe(true);
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: failed?.state.revision ?? 0,
    });
    await ticks(fire.id);
    expect((await store.getFireside(fire.id))?.status).toBe("closed");
    expect(native.createSession.mock.calls[0]?.[1]).toBe(
      native.createSession.mock.calls[1]?.[1]
    );
    expect(native.sendMessage).not.toHaveBeenCalled();
  });

  it("records one failed terminal when an accepted active stream aborts", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const fire = await insert();
    await runtime.firesideTick(fire.id);
    const active = (await store.getFireside(fire.id))?.state.active;
    expect(active).not.toBeNull();
    native.readStream.mockImplementationOnce(async function* () {
      await Promise.resolve();
      yield* [] as never[];
      throw new Error("provider disconnected");
    });

    await runtime.firesideTick(fire.id);

    const terminal = info.mock.calls
      .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
      .filter(
        (record) =>
          record.source === "busy.operation" &&
          record.flow === "fireside" &&
          record.stage === "terminal"
      );
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({
      operationId: active?.messageId,
      outcome: "failed",
    });
    expect(terminal[0]?.errorCode).toBe("Error");
    expect((await store.getFireside(fire.id))?.status).toBe("paused");

    await runtime.firesideTick(fire.id);
    expect(
      info.mock.calls
        .map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)
        .filter(
          (record) =>
            record.source === "busy.operation" &&
            record.flow === "fireside" &&
            record.stage === "terminal"
        )
    ).toHaveLength(1);
    info.mockRestore();
  });
});

describe("confirmed participant cancellation (N-05)", () => {
  async function closing() {
    const fire = await insert();
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: 1,
    });
    return fire.id;
  }
  const silentStream = () =>
    native.readStream.mockImplementation(async function* () {
      yield* [];
    });

  it("endSession = false without session.ended keeps closing, spaces retries and never closes by age", async () => {
    const id = await closing();
    silentStream();
    native.endSession.mockResolvedValue(false);
    await runtime.firesideTick(id);
    let row = await store.getFireside(id);
    expect(row?.status).toBe("closing");
    expect(row?.state.cancelSessions).toEqual(["fire-guest", "fire-primary"]);
    expect(row?.state.cancellations?.["fire-guest"]).toMatchObject({
      attempts: 1,
      computerStopPending: false,
      lastError: "session_not_ended",
    });
    // Not due yet: no second remote call.
    await runtime.firesideTick(id);
    expect(native.endSession).toHaveBeenCalledTimes(2);
    for (let hour = 1; hour <= 12; hour += 1) {
      vi.useFakeTimers({
        now: Date.now() + hour * 3_600_000,
        toFake: ["Date"],
      });
      // biome-ignore lint/performance/noAwaitInLoops: each tick consumes the previous durable state.
      await runtime.firesideTick(id);
    }
    row = await store.getFireside(id);
    expect(row?.status).toBe("closing");
    expect(row?.state.participants.guest.sessionId).toBe("fire-guest");
    expect(row?.state.error).toContain("Still stopping");
    expect(native.computer).not.toHaveBeenCalled();
  });

  it("persists the confirmed end before stopping, and a failed stop resumes at the stop without ending again", async () => {
    const id = await closing();
    native.endSession.mockResolvedValue(true);
    native.computer.mockRejectedValueOnce(new Error("sandbox down"));
    await runtime.firesideTick(id);
    const pending = await store.getFireside(id);
    expect(pending?.state.cancellations?.["fire-guest"]).toMatchObject({
      computerStopPending: true,
      lastError: "computer_stop_failed",
    });
    expect(pending?.state.participants.guest.sessionId).toBe("fire-guest");
    expect(pending?.status).toBe("closing");
    // "Restart": a fresh tick after the backoff stops the computer without a second end.
    laterThanBackoff();
    await runtime.firesideTick(id);
    expect(
      native.endSession.mock.calls.filter((c) => c[1] === "fire-guest")
    ).toHaveLength(1);
    expect(
      native.computer.mock.calls.filter((c) => c[3] === "fire-guest")
    ).toHaveLength(2);
    const released = await store.getFireside(id);
    expect(released?.state.participants.guest).toMatchObject({
      generation: 1,
      sessionId: null,
    });
    expect(released?.state.cancellations?.["fire-guest"]).toBeUndefined();
    await ticks(id, 4);
    expect((await store.getFireside(id))?.status).toBe("closed");
  });

  it("a worker held in endSession never clears the participant's new session", async () => {
    const id = await closing();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    native.endSession.mockImplementationOnce(async () => {
      reached();
      await gate;
      return true;
    });
    const tick = runtime.firesideTick(id);
    await inside;
    // Meanwhile the slot gets a new session (another generation) for the same participant.
    await store.updateFireside(id, (state) => {
      state.participants.guest.sessionId = "fire-guest-2";
      state.participants.guest.generation = 1;
    });
    release();
    await tick;
    const row = await store.getFireside(id);
    expect(native.computer).toHaveBeenCalledWith(
      id,
      expect.anything(),
      { kind: "stop" },
      "fire-guest"
    );
    expect(row?.state.participants.guest.sessionId).toBe("fire-guest-2");
    expect(row?.state.participants.guest.generation).toBe(1);
    expect(row?.state.cancelSessions).not.toContain("fire-guest");
  });

  it("a worker that lost its lease during endSession records nothing and stops nothing", async () => {
    const id = await closing();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const inside = new Promise<void>((resolve) => {
      reached = resolve;
    });
    native.endSession.mockImplementationOnce(async () => {
      reached();
      await gate;
      return true;
    });
    const tick = runtime.firesideTick(id);
    await inside;
    await database
      .update(firesides)
      .set({ leaseUntil: new Date(0) })
      .where(eq(firesides.id, id));
    expect(await store.claimFireside(id)).not.toBeNull();
    release();
    await tick;
    const row = await store.getFireside(id);
    expect(native.computer).not.toHaveBeenCalled();
    expect(row?.state.cancellations?.["fire-guest"]?.computerStopPending).toBe(
      false
    );
    expect(row?.state.participants.guest.sessionId).toBe("fire-guest");
  });

  it("a crash after recording the attempt keeps the request and the next tick retries it", async () => {
    const id = await closing();
    native.endSession.mockRejectedValueOnce(new Error("connection reset"));
    await runtime.firesideTick(id);
    const row = await store.getFireside(id);
    expect(row?.status).toBe("closing");
    expect(row?.state.cancellations?.["fire-guest"]?.attempts).toBe(1);
    expect(row?.state.error).toContain("Still stopping");
    native.endSession.mockResolvedValue(true);
    laterThanBackoff();
    await ticks(id, 6);
    expect((await store.getFireside(id))?.status).toBe("closed");
  });
});

describe("single durable fireside runner (H-32)", () => {
  const runnerRow = async (id: string) =>
    (
      await database
        .select()
        .from(firesideRunners)
        .where(eq(firesideRunners.firesideId, id))
    )[0];
  const expireLease = (id: string) =>
    database
      .update(firesideRunners)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(firesideRunners.firesideId, id));

  it("twenty concurrent schedules from commands, answers and the cron start one runner", async () => {
    const fire = await insert();
    const calls = Array.from({ length: 20 }, (_, n) => {
      if (n % 5 === 0) {
        return store.commandFireside(fire.id, {
          id: randomUUID(),
          kind: "pause",
          revision: 1,
        });
      }
      if (n % 5 === 1) {
        return runtime.recoverFiresides();
      }
      return schedule.scheduleFireside(fire.id);
    });
    const settled = await Promise.allSettled(calls);
    // Only stale-revision pauses may be refused; no schedule fails.
    expect(
      settled.filter((r, n) => r.status === "rejected" && n % 5 !== 0)
    ).toHaveLength(0);
    // Whatever woke it last, one more schedule must not start a second workflow either.
    await schedule.scheduleFireside(fire.id);
    expect(workflowStart).toHaveBeenCalledTimes(1);
    const row = await runnerRow(fire.id);
    expect(row).toMatchObject({ attempts: 1, generation: 1, status: "active" });
    // Each of the 13 schedules counted a wake; cron calls only wake a fireside without a live runner.
    expect(row?.wakes).toBeGreaterThanOrEqual(13);
    expect(workflowStart.mock.calls[0]?.[1]).toEqual([fire.id, row?.runId]);
    expect(row?.workflowRunId?.startsWith("wrun_")).toBe(true);
  });

  it("recovers a dead runner after its lease, and the replaced runner stops without touching the room", async () => {
    const fire = await insert();
    await schedule.scheduleFireside(fire.id);
    const first = await runnerRow(fire.id);
    // Within the lease the cron leaves the live runner alone.
    await runtime.recoverFiresides();
    expect(workflowStart).toHaveBeenCalledTimes(1);
    await expireLease(fire.id);
    expect(await store.pendingFiresides()).toEqual([{ id: fire.id }]);
    await runtime.recoverFiresides();
    const second = await runnerRow(fire.id);
    expect(workflowStart).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ attempts: 2, generation: 2 });
    expect(second?.runId).not.toBe(first?.runId);
    const before = await store.getFireside(fire.id);
    expect(
      await runtime.runFiresideRunner(fire.id, first?.runId ?? "")
    ).toBeNull();
    expect((await store.getFireside(fire.id))?.version).toBe(before?.version);
    expect(native.sendMessage).not.toHaveBeenCalled();
    expect(
      await runtime.runFiresideRunner(fire.id, second?.runId ?? "")
    ).toBeGreaterThan(0);
    expect((await store.getFireside(fire.id))?.version).toBeGreaterThan(
      before?.version ?? 0
    );
  });

  it("a wake that lands between the heartbeat and going idle keeps the runner alive", async () => {
    const fire = await insert();
    await schedule.scheduleFireside(fire.id);
    const { runId } = (await runnerRow(fire.id)) ?? { runId: "" };
    const beat = await runner.heartbeatRunner(fire.id, runId);
    expect(beat).not.toBeNull();
    await runner.wakeRunner(database as never, fire.id);
    expect(await runner.idleRunner(fire.id, runId, beat?.wakes ?? 0)).toBe(
      false
    );
    const again = await runner.heartbeatRunner(fire.id, runId);
    expect(await runner.idleRunner(fire.id, runId, again?.wakes ?? 0)).toBe(
      true
    );
    expect((await runnerRow(fire.id))?.status).toBe("idle");
  });

  it("a waiting room goes idle, is never closed or restarted by age, and a command wakes it with its transcript", async () => {
    const fire = await insert();
    await store.updateFireside(fire.id, (state) => {
      state.status = "waiting";
      state.remaining = { guest: 0, primary: 0 };
      state.messages.push({
        at: "now",
        id: "opinion",
        speaker: "guest",
        text: "Ship it",
      });
    });
    await schedule.scheduleFireside(fire.id);
    const { runId } = (await runnerRow(fire.id)) ?? { runId: "" };
    expect(await runtime.runFiresideRunner(fire.id, runId)).toBeNull();
    expect((await runnerRow(fire.id))?.status).toBe("idle");
    vi.useFakeTimers({ now: Date.now() + 30 * 86_400_000, toFake: ["Date"] });
    await database
      .update(firesides)
      .set({ updatedAt: new Date(0) })
      .where(eq(firesides.id, fire.id));
    expect(await runtime.recoverFiresides()).toEqual({ firesides: 0 });
    expect(workflowStart).toHaveBeenCalledTimes(1);
    const idle = await store.getFireside(fire.id);
    expect(idle?.status).toBe("waiting");
    expect(idle?.state.cancelSessions).toEqual([]);
    const woken = await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "continue",
      revision: idle?.state.revision ?? 0,
    });
    expect(await runnerRow(fire.id)).toMatchObject({
      generation: 2,
      status: "starting",
    });
    await schedule.scheduleFireside(fire.id);
    expect(workflowStart).toHaveBeenCalledTimes(2);
    expect(woken?.state.messages.map((m) => m.text)).toEqual(["Ship it"]);
  });

  it("a closing room with unconfirmed sessions stays recoverable and blocks a new fireside", async () => {
    const fire = await insert();
    await store.commandFireside(fire.id, {
      id: randomUUID(),
      kind: "close",
      revision: 1,
    });
    await expireLease(fire.id);
    expect(await store.pendingFiresides()).toEqual([{ id: fire.id }]);
    expect((await store.createFireside(bot(), randomUUID())).id).toBe(fire.id);
  });

  it("a failed start hands the start back for the cron instead of losing the runner", async () => {
    const fire = await insert();
    workflowStart.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(schedule.scheduleFireside(fire.id)).rejects.toThrow();
    expect(await runnerRow(fire.id)).toMatchObject({
      lastError: "queue unavailable",
      status: "starting",
    });
    await runtime.recoverFiresides();
    expect(workflowStart).toHaveBeenCalledTimes(2);
    expect((await runnerRow(fire.id))?.status).toBe("active");
  });
});
