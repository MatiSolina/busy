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
import type { PeerBindingDeps } from "./lib/chat/peer-binding";
import { peerWindow } from "./lib/chat/sync";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema map to the database client.
import * as schema from "./lib/db/schema";

// H-24 / N-07: a `peer-N` consultation is bound to the bot the asking bot really dispatched to,
// never to "whoever answers", even when the directory changes between its pick and the sync,
// and the directory has one total order (created_at, id) for the API, the bot and the hub.

const h = vi.hoisted(() => ({ caller: "origin", db: vi.fn() }));

vi.mock("./lib/db", () => ({
  bots: schema.bots,
  consultations: schema.consultations,
  cursors: schema.cursors,
  db: h.db,
  events: schema.events,
}));
vi.mock("./lib/bot-auth", () => ({
  botFromRequest: async () => ({ slug: h.caller }),
}));
vi.mock("@vercel/oidc", () => ({
  getVercelOidcToken: async () => "relay-oidc",
}));

const ORIGIN = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const SAME_TIME = "2026-11-08T10:00:00Z";
const child = (n: number) =>
  `wrun_01ARYZ6S41TSV4RRFFQ69G5F${String(n).padStart(2, "0")}`;

let client: PGlite;

/** The remote side: which deployment holds each child session. */
const remote = new Map<string, string>();
/** What the dispatch recorded (hub-signed principal), per call; absent = legacy OIDC. */
const dispatched = new Map<string, string>();
const confirm = vi.fn(
  async (peer: { id: string }, childSessionId: string) =>
    await Promise.resolve(remote.get(childSessionId) === peer.id)
);
const recordedTarget = vi.fn(
  async (_from: unknown, _parent: string, callId: string) =>
    await Promise.resolve(dispatched.get(callId) ?? null)
);
const deps: PeerBindingDeps = { confirm, recordedTarget };

async function addBot(id: string, slug: string, createdAt = SAME_TIME) {
  await client.query(
    `INSERT INTO bots (id, slug, name, description, status, created_at)
     VALUES ($1, $2, $2, 'd', 'ready', $3)`,
    [id, slug, createdAt]
  );
}

/** What the asking bot sees: /api/bot/directory, then its pickPeer window. */
async function botDirectory(): Promise<string[]> {
  const { GET } = await import("./app/api/bot/directory/route");
  const res = await GET(
    new Request("https://hub.example.com/api/bot/directory")
  );
  const body = (await res.json()) as { id: string }[];
  return peerWindow(body.map(({ id }) => id));
}

const opened = (
  slot: number,
  callId: string,
  childSessionId: string,
  index = 0
) => ({
  at: new Date(SAME_TIME),
  data: {
    data: {
      name: `peer-${slot}`,
      owner: { callId },
      sessionId: childSessionId,
    },
    type: "child.opened",
  },
  index,
  line: 1,
  type: "child.opened",
});

async function sync(
  rows: ReturnType<typeof opened>[],
  binding: PeerBindingDeps = deps
) {
  const { saver } = await import("./lib/chat/store");
  const save = saver(
    { billing: "gateway", id: ORIGIN, slug: "origin" } as Parameters<
      typeof saver
    >[0],
    "origin-session",
    true,
    "gateway",
    binding
  );
  await save(rows, 2);
}

const row = async (callId: string) =>
  (
    await client.query<{ to_bot_id: string | null }>(
      "SELECT to_bot_id FROM consultations WHERE call_id = $1",
      [callId]
    )
  ).rows[0];

const quietWarn = () =>
  vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeAll(async () => {
  vi.stubEnv("BOTS_DOMAIN", "bots.example.com");
  client = new PGlite();
  await client.exec(`
    CREATE TABLE events (
      at timestamptz NOT NULL, bot_id uuid NOT NULL, data jsonb NOT NULL,
      index integer NOT NULL, line integer NOT NULL, session_id text NOT NULL,
      type text NOT NULL, PRIMARY KEY (session_id, line, index)
    );
    CREATE TABLE cursors (
      bot_id uuid NOT NULL, next_line integer NOT NULL DEFAULT 0, session_id text PRIMARY KEY
    );
    CREATE TABLE bots (
      id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL,
      description text NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL,
      deletion_state text
    );
    CREATE TABLE consultations (
      call_id text UNIQUE NOT NULL, child_session_id text,
      created_at timestamptz NOT NULL DEFAULT now(), from_bot_id uuid NOT NULL,
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), parent_session_id text NOT NULL,
      status text NOT NULL DEFAULT 'open', to_bot_id uuid
    );
  `);
  h.db.mockReturnValue(drizzle(client, { schema }));
});

beforeEach(async () => {
  await client.exec("TRUNCATE events, cursors, consultations, bots");
  remote.clear();
  dispatched.clear();
  confirm.mockClear();
  recordedTarget.mockClear();
  await addBot(ORIGIN, "origin", "2026-11-08T09:00:00Z");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
  vi.doUnmock("./lib/db");
  vi.doUnmock("./lib/bot-auth");
});

describe("directory order (N-07)", () => {
  it("breaks created_at ties by id the same way in the API and the hub's sync", async () => {
    await addBot(C, "carol");
    await addBot(A, "alice");
    await addBot(B, "bob");
    const { peerDirectory } = await import("./lib/chat/peer-binding");
    const hubWindow = (await peerDirectory({ id: ORIGIN })).window.map(
      ({ id }) => id
    );
    expect(await botDirectory()).toEqual([A, B, C]);
    expect(hubWindow).toEqual([A, B, C]);
  });
});

describe("consulted bot binding (H-24)", () => {
  it("keeps the recorded target when a new bot shifts the slots before the sync", async () => {
    await addBot(A, "alice", "2026-11-08T10:00:00Z");
    await addBot(B, "bob", "2026-11-08T10:02:00Z");
    const [, picked] = await botDirectory();
    expect(picked).toBe(B);
    // Dispatch: a hub credential for origin → B, and eve opens the child on B.
    dispatched.set("call-b", B);
    remote.set(child(1), B);
    await addBot(C, "carol", "2026-11-08T10:01:00Z");
    const [, shifted] = await botDirectory();
    expect(shifted).toBe(C);

    await sync([opened(2, "call-b", child(1))]);

    expect((await row("call-b"))?.to_bot_id).toBe(B);
    // Only the recorded candidate was confirmed; C (the shifted slot) was never asked.
    expect(confirm.mock.calls.map(([peer]) => peer.id)).toEqual([B]);
  });

  it("fails closed for a legacy dispatch whose slot shifted, without asking other bots", async () => {
    const warn = quietWarn();
    await addBot(A, "alice", "2026-11-08T10:00:00Z");
    await addBot(B, "bob", "2026-11-08T10:02:00Z");
    remote.set(child(2), B);
    await addBot(C, "carol", "2026-11-08T10:01:00Z");

    await sync([opened(2, "call-legacy", child(2))]);

    expect((await row("call-legacy"))?.to_bot_id).toBeNull();
    expect(confirm.mock.calls.map(([peer]) => peer.id)).toEqual([C]);
    expect(
      warn.mock.calls.map(([line]) => JSON.parse(String(line)))
    ).toContainEqual(
      expect.objectContaining({
        callId: "call-legacy",
        reason: "peer_unverified",
      })
    );
    warn.mockRestore();
  });

  it("fails closed when the recorded target was deleted before the sync", async () => {
    const warn = quietWarn();
    await addBot(A, "alice", "2026-11-08T10:00:00Z");
    await addBot(B, "bob", "2026-11-08T10:02:00Z");
    dispatched.set("call-gone", B);
    remote.set(child(3), B);
    await client.query("DELETE FROM bots WHERE id = $1", [B]);

    await sync([opened(2, "call-gone", child(3))]);

    expect((await row("call-gone"))?.to_bot_id).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never takes a 2xx from a bot other than the single candidate", async () => {
    const warn = quietWarn();
    await addBot(A, "alice");
    await addBot(B, "bob");
    // Every other deployment would say yes; only the recorded target A is asked, and it says no.
    const yesExceptA = vi.fn(
      async (peer: { id: string }) => await Promise.resolve(peer.id !== A)
    );
    dispatched.set("call-x", A);
    await sync([opened(2, "call-x", child(4))], {
      confirm: yesExceptA,
      recordedTarget,
    });
    expect((await row("call-x"))?.to_bot_id).toBeNull();
    expect(yesExceptA).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not probe again a consultation that is already persisted", async () => {
    await addBot(A, "alice");
    remote.set(child(5), A);
    await sync([opened(1, "call-once", child(5))]);
    expect((await row("call-once"))?.to_bot_id).toBe(A);
    confirm.mockClear();
    recordedTarget.mockClear();
    await sync([opened(1, "call-once", child(5))]);
    expect(confirm).not.toHaveBeenCalled();
    expect(recordedTarget).not.toHaveBeenCalled();
    expect((await row("call-once"))?.to_bot_id).toBe(A);
  });

  it("caps the probes per batch and leaves the rest unattributed", async () => {
    const warn = quietWarn();
    await addBot(A, "alice");
    const { MAX_BINDINGS_PER_BATCH } = await import("./lib/chat/peer-binding");
    const rows = Array.from({ length: MAX_BINDINGS_PER_BATCH + 3 }, (_, i) => {
      remote.set(child(10 + i), A);
      return opened(1, `call-${i}`, child(10 + i), i);
    });
    await sync(rows);
    expect(recordedTarget).toHaveBeenCalledTimes(MAX_BINDINGS_PER_BATCH);
    expect(confirm).toHaveBeenCalledTimes(MAX_BINDINGS_PER_BATCH);
    const unattributed = await client.query(
      "SELECT 1 FROM consultations WHERE to_bot_id IS NULL"
    );
    expect(unattributed.rows).toHaveLength(3);
    warn.mockRestore();
  });

  it("stops at the batch deadline", async () => {
    const warn = quietWarn();
    await addBot(A, "alice");
    remote.set(child(30), A);
    remote.set(child(31), A);
    const { bindConsultationPeers } = await import("./lib/chat/peer-binding");
    let clock = 0;
    const slow: PeerBindingDeps = {
      confirm: async (peer, id) => {
        clock += 11_000; // the first confirmation spends the whole budget
        return await confirm(peer, id);
      },
      recordedTarget,
    };
    const bound = await bindConsultationPeers(
      { id: ORIGIN, slug: "origin" },
      "origin-session",
      [
        { callId: "d1", childSessionId: child(30), slot: 1 },
        { callId: "d2", childSessionId: child(31), slot: 1 },
      ],
      slow,
      () => clock
    );
    expect(bound.get("d1")).toEqual({ toBotId: A });
    expect(bound.get("d2")).toEqual({
      reason: "budget_exhausted",
      toBotId: null,
    });
    warn.mockRestore();
  });

  it("probes before the save transaction writes events or the cursor", async () => {
    await addBot(A, "alice");
    remote.set(child(6), A);
    const writesSeen: number[] = [];
    const watching: PeerBindingDeps = {
      confirm: async (peer, id) => {
        const { rows } = await client.query(
          "SELECT 1 FROM events UNION ALL SELECT 1 FROM cursors"
        );
        writesSeen.push(rows.length);
        return await confirm(peer, id);
      },
      recordedTarget,
    };
    await sync([opened(1, "call-tx", child(6))], watching);
    expect(writesSeen).toEqual([0]);
    expect((await row("call-tx"))?.to_bot_id).toBe(A);
  });

  it.each([
    ".",
    "..",
    "../x",
    "a/b",
    "wrun_..",
    "",
    "WRUN_01ARYZ6S41TSV4RRFFQ69G5FAV",
    "wrun_01ARYZ6S41TSV4RRFFQ69G5FA/",
  ])("neither probes nor stores a child session id like %j", async (bad) => {
    const warn = quietWarn();
    await addBot(A, "alice");
    await sync([opened(1, "call-bad", bad)]);
    expect(await row("call-bad")).toBeUndefined();
    expect(confirm).not.toHaveBeenCalled();
    expect(recordedTarget).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("dispatch evidence readers", () => {
  it("confirms only the candidate, and only when the response names that session", async () => {
    vi.stubEnv("DEV_RELAY_URL", "https://relay.example.com");
    const { confirmChildSession } = await import("./lib/chat/peer-binding");
    const id = child(7);
    const seen: { auth: string | null; url: string }[] = [];
    const answers = [
      new Response("{}", { headers: { "x-eve-session-id": id }, status: 200 }),
      new Response("{}", { status: 200 }),
      new Response("{}", {
        headers: { "x-eve-session-id": child(8) },
        status: 200,
      }),
      new Response("{}", { status: 404 }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        await Promise.resolve();
        seen.push({
          auth: new Headers(init.headers).get("authorization"),
          url,
        });
        const next = answers.shift();
        if (!next) {
          throw new Error("network down");
        }
        return next;
      })
    );
    const peer = { id: B, slug: "bob" };
    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: one scripted answer per probe, in order
      results.push(await confirmChildSession(peer, id));
    }
    expect(results).toEqual([true, false, false, false, false]);
    expect(seen[0]).toEqual({
      auth: "Bearer relay-oidc",
      url: `https://relay.example.com/api/dev/bots/bob/eve/v1/session/${id}/stream?includeTailIndex=1&startIndex=0`,
    });
    // A malformed id never reaches the network.
    expect(await confirmChildSession(peer, "../x")).toBe(false);
    expect(seen).toHaveLength(5);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv("BOTS_DOMAIN", "bots.example.com");
  });

  it("reads the recorded target only from a hub credential for this asking bot", async () => {
    vi.stubEnv("DEV_RELAY_URL", "https://relay.example.com");
    const { recordedTargetFromChild } = await import("./lib/chat/peer-binding");
    const stream = (principalId: string) =>
      new Response(
        `${JSON.stringify({
          facts: [
            { data: {}, type: "session.started" },
            {
              data: {
                deliveryId: "d",
                principal: { id: principalId, type: "service" },
              },
              type: "delivery.admitted",
            },
          ],
        })}\n`,
        { headers: { "x-eve-stream-tail-index": "0" }, status: 200 }
      );
    const principals = [
      `busy-hub:consultation:${ORIGIN}:${B}`,
      `busy-hub:consultation:${A}:${B}`,
      "https://oidc.vercel.com/t:owner:t:project:bot-origin:environment:production",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => await Promise.resolve(stream(principals.shift() ?? "")))
    );
    const from = { id: ORIGIN, slug: "origin" };
    const read = () =>
      recordedTargetFromChild(from, "origin-session", "call", child(9));
    expect(await read()).toBe(B);
    // Another asking bot's credential, or the legacy OIDC principal, records nothing.
    expect(await read()).toBeNull();
    expect(await read()).toBeNull();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.stubEnv("BOTS_DOMAIN", "bots.example.com");
  });
});
