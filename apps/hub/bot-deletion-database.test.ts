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
// biome-ignore lint/performance/noNamespaceImport: Drizzle needs the complete schema map for the test database.
import * as schema from "./lib/db/schema";

// A fake private Blob store keyed by pathname (signed URLs name their path; PUT lands on exactly it).
const h = vi.hoisted(() => ({
  database: undefined as unknown,
  getGate: undefined as Promise<void> | undefined,
  getStarted: (() => undefined) as () => void,
  store: new Map<string, number>(),
}));
const blobUrl = (pathname: string) => `https://blob.test/${pathname}`;
const pathOf = (url: string) =>
  decodeURIComponent(new URL(url).pathname.slice(1));

vi.mock("@vercel/blob", () => ({
  del: vi.fn((target: string | string[]) => {
    for (const item of Array.isArray(target) ? target : [target]) {
      h.store.delete(item.startsWith("https://") ? pathOf(item) : item);
    }
    return Promise.resolve();
  }),
  issueSignedToken: vi.fn((options: { pathname: string }) =>
    Promise.resolve(options)
  ),
  list: vi.fn(({ prefix }: { prefix: string }) =>
    Promise.resolve({
      blobs: [...h.store.keys()]
        .filter((pathname) => pathname.startsWith(prefix))
        .map((pathname) => ({ pathname, url: blobUrl(pathname) })),
      hasMore: false,
    })
  ),
  presignUrl: vi.fn((_token: unknown, options: { pathname: string }) =>
    Promise.resolve({ presignedUrl: blobUrl(options.pathname) })
  ),
  put: vi.fn((pathname: string) => {
    h.store.set(pathname, 4);
    return Promise.resolve({ url: blobUrl(pathname) });
  }),
}));
vi.mock("./lib/db", async () => ({
  ...(await import("./lib/db/schema")),
  db: () => h.database,
}));
vi.mock("./lib/routines/schedule", () => ({ deleteBotSchedules: vi.fn() }));
vi.mock("./lib/vercel/client", () => ({
  deleteProject: vi.fn(),
  projectId: vi.fn(),
}));

const migration = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./drizzle/${name}`, import.meta.url)),
    "utf8"
  );

// The tables as they were before 0019/0023/0028/0029 (created by drizzle push in production).
const BASE_SCHEMA = `
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  CREATE TABLE bots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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
    at timestamptz NOT NULL DEFAULT now(),
    bot_id uuid NOT NULL,
    data jsonb NOT NULL DEFAULT '{}',
    index integer NOT NULL DEFAULT 0,
    line integer NOT NULL,
    session_id text NOT NULL,
    type text NOT NULL DEFAULT 'reply',
    PRIMARY KEY (session_id, line, index)
  );
  CREATE TABLE cursors (
    bot_id uuid NOT NULL,
    next_line integer NOT NULL DEFAULT 0,
    session_id text PRIMARY KEY
  );
  CREATE TABLE messages (
    bot_id uuid NOT NULL,
    client_context jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivery_id text,
    file_ids jsonb NOT NULL DEFAULT '[]',
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payload_hash text,
    status text NOT NULL DEFAULT 'pending',
    text text NOT NULL DEFAULT 'hi'
  );
  CREATE TABLE consultations (
    call_id text NOT NULL UNIQUE,
    child_session_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    from_bot_id uuid NOT NULL,
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_session_id text NOT NULL DEFAULT 'parent',
    status text NOT NULL DEFAULT 'open',
    to_bot_id uuid
  );
  CREATE TABLE memories (
    bot_slug text PRIMARY KEY,
    content text NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 1
  );
  CREATE TABLE files (
    bot_id uuid NOT NULL,
    content_type text NOT NULL DEFAULT 'text/plain',
    created_at timestamptz NOT NULL DEFAULT now(),
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL DEFAULT 'notes.txt',
    pathname text NOT NULL,
    size integer NOT NULL DEFAULT 4,
    source text NOT NULL DEFAULT 'user',
    status text NOT NULL DEFAULT 'pending',
    version integer NOT NULL DEFAULT 1,
    UNIQUE (bot_id, name, version)
  );
`;

async function migratedDatabase(seed = "") {
  const client = new PGlite();
  await client.exec(BASE_SCHEMA);
  if (seed) {
    await client.exec(seed);
  }
  await client.exec(migration("0019_library_objects.sql"));
  await client.exec(migration("0023_stale_library_uploads.sql"));
  await client.exec(migration("0028_bot_deploy_generation.sql"));
  await client.exec(migration("0029_bot_deletion_files.sql"));
  return client;
}

const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const botB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const botC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const slug = "release-captain";
const upload = { contentType: "text/plain", name: "notes.txt", size: 4 };

let client: PGlite;
let files: typeof import("./lib/files");
let objects: typeof import("./lib/library-objects");
let deletion: typeof import("./lib/bots/deletion");

const rows = async <T>(query: string, params: unknown[] = []) =>
  (await client.query<T>(query, params)).rows;
const count = async (table: string, where = "true", params: unknown[] = []) =>
  Number(
    (
      await rows<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE ${where}`,
        params
      )
    )[0]?.n
  );
const botRow = async (id: string) =>
  (await client.query<schema.BotRow>("SELECT 1 FROM bots WHERE id = $1", [id]))
    .rows.length > 0;
const asBot = (id: string, botSlug = slug) =>
  ({ id, slug: botSlug }) as schema.BotRow;
const putSigned = (uploadUrl: string) => h.store.set(pathOf(uploadUrl), 4);

beforeAll(async () => {
  client = await migratedDatabase();
  h.database = drizzle(client, { schema });
  files = await import("./lib/files");
  objects = await import("./lib/library-objects");
  deletion = await import("./lib/bots/deletion");
});

beforeEach(async () => {
  h.store.clear();
  h.getGate = undefined;
  await client.exec(`
    DELETE FROM files; DELETE FROM library_objects; DELETE FROM events; DELETE FROM cursors;
    DELETE FROM messages; DELETE FROM consultations; DELETE FROM memories; DELETE FROM bots;
    DELETE FROM bot_tombstones;
  `);
  await client.query(
    "INSERT INTO bots (id, slug) VALUES ($1, $2), ($3, 'helper')",
    [botA, slug, botC]
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const stored = h.store.get(pathOf(url));
      if (init?.method === "HEAD") {
        return stored === undefined
          ? new Response(null, { status: 404 })
          : new Response(null, {
              headers: { "content-length": String(stored) },
            });
      }
      if (h.getGate) {
        h.getStarted();
        await h.getGate;
      }
      return stored === undefined
        ? new Response(null, { status: 404 })
        : new Response("data");
    })
  );
});

afterAll(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

// Fake external effects: Vercel projects by name/id and per-bot schedule namespaces.
function externals() {
  const projects = new Map<string, string>();
  const schedules = new Set<string>();
  const deleted: string[] = [];
  const deps: import("./lib/bots/deletion").DeletionDeps = {
    deleteBlobs: (bot) => files.deleteBotBlobs(bot),
    deleteProjectById: (id) => {
      deleted.push(id);
      for (const [name, projectId] of projects) {
        if (projectId === id) {
          projects.delete(name);
        }
      }
      return Promise.resolve();
    },
    deleteSchedules: (botId) => {
      schedules.delete(botId);
      return Promise.resolve();
    },
    lookupProjectId: (name) => Promise.resolve(projects.get(name) ?? null),
  };
  return { deleted, deps, projects, schedules };
}

/** The workflow's control flow (workflows/delete-bot.ts) without the durable runtime. */
async function runDeletion(
  botId: string,
  token: string,
  deps: import("./lib/bots/deletion").DeletionDeps
) {
  try {
    for (const stage of deletion.DELETION_STAGES) {
      // biome-ignore lint/performance/noAwaitInLoops: The deletion's effects run in order.
      if (!(await deletion.runDeletionStage(botId, token, stage, deps))) {
        return "gone";
      }
    }
    if (!(await deletion.finalizeBotDeletion(botId, token))) {
      return "gone";
    }
  } catch (error) {
    await deletion.recordBotDeletionFailure(
      botId,
      token,
      error instanceof Error ? error.message : "failed"
    );
    return "failed";
  }
  await deletion.collectAfterDeletion();
  return "deleted";
}

/**
 * A run that crashes, then the cron path: once the backoff passes the deletion is claimed (only once)
 * and restarted with the same token. Returns what each stage observed.
 */
async function crashAndResume(
  token: string,
  crashing: import("./lib/bots/deletion").DeletionDeps,
  deps: import("./lib/bots/deletion").DeletionDeps
) {
  const failed = await runDeletion(botA, token, crashing);
  const stillThere = await botRow(botA);
  await client.query(
    "UPDATE bots SET deletion_next_attempt_at = now() - interval '1 second' WHERE id = $1",
    [botA]
  );
  const claimed = await deletion.claimDueBotDeletions();
  const claimedAgain = await deletion.claimDueBotDeletions();
  const resumed = await runDeletion(botA, token, deps);
  return [failed, stillThere, claimed, claimedAgain, resumed];
}

async function seedOwnedData(botId: string, botSlug: string) {
  await client.query(
    `INSERT INTO events (bot_id, line, session_id) VALUES ($1, 1, $2);
     `.trim(),
    [botId, `s-${botId}`]
  );
  await client.query(
    "INSERT INTO cursors (bot_id, session_id) VALUES ($1, $2)",
    [botId, `s-${botId}`]
  );
  await client.query("INSERT INTO messages (bot_id) VALUES ($1)", [botId]);
  await client.query("INSERT INTO memories (bot_slug) VALUES ($1)", [botSlug]);
}

describe("migration 0029 (H-10 references)", () => {
  it("quarantines legacy orphans instead of deleting them, nulls unknown receivers and is idempotent", async () => {
    const ghost = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const legacy = await migratedDatabase(`
      INSERT INTO bots (id, slug) VALUES ('${botA}', 'alive');
      INSERT INTO events (bot_id, line, session_id) VALUES ('${ghost}', 1, 'ghost');
      INSERT INTO messages (bot_id) VALUES ('${botA}');
      INSERT INTO consultations (call_id, from_bot_id, to_bot_id) VALUES ('c1', '${botA}', '${ghost}');
      INSERT INTO files (bot_id, pathname, status) VALUES ('${botA}', 'bots/alive/1-a.txt', 'pending');
    `);
    const notices: string[] = [];
    const validated = async () =>
      Object.fromEntries(
        (
          await legacy.query<{ conname: string; convalidated: boolean }>(
            "SELECT conname, convalidated FROM pg_constraint WHERE conname LIKE '%bots_%_fk' ORDER BY conname"
          )
        ).rows.map((row) => [row.conname, row.convalidated])
      );

    expect(await validated()).toMatchObject({
      consultations_from_bot_id_bots_id_fk: true,
      consultations_to_bot_id_bots_id_fk: true,
      events_bot_id_bots_id_fk: false,
      files_bot_id_bots_id_fk: true,
      messages_bot_id_bots_id_fk: true,
    });
    // Nothing deleted: the orphan event is kept in quarantine; the receiver is NULL, the thread stays.
    expect(
      (await legacy.query("SELECT 1 FROM events WHERE bot_id = $1", [ghost]))
        .rows
    ).toHaveLength(1);
    expect(
      (
        await legacy.query<{ to_bot_id: string | null }>(
          "SELECT to_bot_id FROM consultations"
        )
      ).rows
    ).toEqual([{ to_bot_id: null }]);
    // The legacy pending reservation got a deadline.
    expect(
      (
        await legacy.query<{ ok: boolean }>(
          "SELECT pending_until = created_at + interval '60 minutes' AS ok FROM files"
        )
      ).rows[0]?.ok
    ).toBe(true);
    // The quarantined FK still guards new writes.
    await expect(
      legacy.query(
        "INSERT INTO events (bot_id, line, session_id) VALUES ($1, 2, 'x')",
        [ghost]
      )
    ).rejects.toThrow();

    // Re-applying reports exactly the quarantined orphans and nothing else.
    await legacy.exec(migration("0029_bot_deletion_files.sql"), {
      onNotice: (notice) => notices.push(notice.message ?? ""),
    });
    expect(notices.filter((n) => n.startsWith("bot reference"))).toEqual([
      "bot reference orphans kept in quarantine: events.bot_id = 1 rows (events_bot_id_bots_id_fk stays NOT VALID)",
    ]);

    // After a reviewed cleanup, applying the migration again validates it; a third run changes nothing.
    await legacy.query("DELETE FROM events WHERE bot_id = $1", [ghost]);
    await legacy.exec(migration("0029_bot_deletion_files.sql"));
    expect((await validated()).events_bot_id_bots_id_fk).toBe(true);
    await legacy.exec(migration("0029_bot_deletion_files.sql"));
    expect(Object.values(await validated()).every(Boolean)).toBe(true);
    await legacy.close();
  });

  it("rejects an invalid deletion state", async () => {
    await expect(
      client.query("UPDATE bots SET deletion_state = 'gone' WHERE id = $1", [
        botA,
      ])
    ).rejects.toThrow();
    await expect(
      client.query(
        "UPDATE bots SET deletion_state = 'deleting' WHERE id = $1",
        [botA]
      )
    ).rejects.toThrow();
  });

  it("cascades only the bot's own data and keeps consultations other bots opened towards it", async () => {
    await seedOwnedData(botA, slug);
    await client.query(
      `INSERT INTO consultations (call_id, from_bot_id, to_bot_id) VALUES
         ('own', $1, $2), ('theirs', $2, $1)`,
      [botA, botC]
    );
    await client.query(
      "INSERT INTO files (bot_id, pathname, status) VALUES ($1, 'bots/x/1', 'ready')",
      [botA]
    );

    await client.query("DELETE FROM bots WHERE id = $1", [botA]);

    for (const table of ["events", "cursors", "messages", "files"]) {
      // biome-ignore lint/performance/noAwaitInLoops: Small assertions over a handful of tables.
      expect(await count(table, "bot_id = $1", [botA])).toBe(0);
    }
    expect(await count("memories", "bot_slug = $1", [slug])).toBe(0);
    expect(
      await rows<{ call_id: string; from_bot_id: string; to_bot_id: null }>(
        "SELECT call_id, from_bot_id, to_bot_id FROM consultations"
      )
    ).toEqual([{ call_id: "theirs", from_bot_id: botC, to_bot_id: null }]);
    // A writer that still holds the deleted bot's row cannot leave an orphan.
    await expect(
      client.query(
        "INSERT INTO events (bot_id, line, session_id) VALUES ($1, 9, 'late')",
        [botA]
      )
    ).rejects.toThrow();
  });
});

describe("durable deletion (H-11)", () => {
  it("reserves the slug, refuses uploads and keeps one token across repeated requests", async () => {
    const first = await deletion.requestBotDeletion(botA);
    const second = await deletion.requestBotDeletion(botA);
    expect(first?.start).toBe(true);
    expect(second).toEqual({ start: false, token: first?.token });

    // The row still holds the slug: a new bot with it is refused by the unique key (insertBot suffixes).
    await expect(
      client.query("INSERT INTO bots (slug) VALUES ($1)", [slug])
    ).rejects.toThrow();
    await expect(
      files.registerFile(asBot(botA), upload, "user")
    ).rejects.toThrow("bot is being deleted");
  });

  it("refuses a completion for a bot marked deleting after its reservation", async () => {
    const reserved = await files.registerFile(asBot(botA), upload, "user");
    putSigned(reserved.uploadUrl);
    await deletion.requestBotDeletion(botA);
    expect(await files.completeFile(botA, reserved.fileId)).toBe(false);
  });

  it("resumes after a crash following every step without repeating effects on anyone else", async () => {
    const steps = [...deletion.DELETION_STAGES, "finalize"] as const;
    for (const crashAfter of steps) {
      // biome-ignore lint/performance/noAwaitInLoops: Each crash point is an independent scenario.
      await client.exec(
        "DELETE FROM files; DELETE FROM library_objects; DELETE FROM bot_tombstones; DELETE FROM bots;"
      );
      h.store.clear();
      await client.query(
        "INSERT INTO bots (id, slug) VALUES ($1, $2), ($3, 'helper')",
        [botA, slug, botC]
      );
      await seedOwnedData(botA, slug);
      const ext = externals();
      ext.projects.set(`bot-${slug}`, "prj_a");
      ext.projects.set("bot-helper", "prj_c");
      ext.schedules.add(botA);
      ext.schedules.add(botC);
      const reserved = await files.registerFile(asBot(botA), upload, "user");
      putSigned(reserved.uploadUrl);
      h.store.set("bots/helper/1-keep.txt", 4);

      // Crash right after this step's effect, before the run records progress.
      const crashing = { ...ext.deps };
      const crash = () => {
        throw new Error(`crash after ${crashAfter}`);
      };
      if (crashAfter === "code-tasks") {
        crashing.requestBotCodeTaskShutdown = () =>
          Promise.resolve({ pending: 0 }).then((value) => {
            crash();
            return value;
          });
      } else if (crashAfter === "project") {
        crashing.deleteProjectById = async (id) => {
          await ext.deps.deleteProjectById(id);
          crash();
        };
      } else if (crashAfter === "schedules") {
        crashing.deleteSchedules = async (id) => {
          await ext.deps.deleteSchedules(id);
          crash();
        };
      } else if (crashAfter === "blobs") {
        crashing.deleteBlobs = async (bot) => {
          await ext.deps.deleteBlobs(bot);
          crash();
        };
      }
      const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
      const trace =
        crashAfter === "finalize"
          ? // The crash lands after the hard delete: the resumed run sees nothing to do.
            [
              await runDeletion(botA, token, ext.deps),
              await runDeletion(botA, token, ext.deps),
            ]
          : await crashAndResume(token, crashing, ext.deps);
      expect(trace).toEqual(
        crashAfter === "finalize"
          ? ["deleted", "gone"]
          : ["failed", true, [{ botId: botA, token }], [], "deleted"]
      );

      expect(await botRow(botA)).toBe(false);
      expect(new Set(ext.deleted)).toEqual(new Set(["prj_a"]));
      expect(ext.projects.get("bot-helper")).toBe("prj_c");
      expect([...ext.schedules]).toEqual([botC]);
      expect(h.store.has(pathOf(reserved.uploadUrl))).toBe(false);
      expect(h.store.has("bots/helper/1-keep.txt")).toBe(true);
      expect(await count("events", "bot_id = $1", [botA])).toBe(0);
      expect(
        await rows("SELECT slug, vercel_project_id FROM bot_tombstones")
      ).toEqual([{ slug, vercel_project_id: "prj_a" }]);
    }
  });

  it("never touches a new bot that reuses the slug after the deletion finished", async () => {
    const ext = externals();
    ext.projects.set(`bot-${slug}`, "prj_a");
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");

    // Bot B takes the slug and gets a new project under the same name.
    await client.query("INSERT INTO bots (id, slug) VALUES ($1, $2)", [
      botB,
      slug,
    ]);
    ext.projects.set(`bot-${slug}`, "prj_b");
    const fresh = await files.registerFile(asBot(botB), upload, "user");
    putSigned(fresh.uploadUrl);

    // A stale run (or the cron) with A's token does nothing; nor does the late sweep of A.
    expect(await runDeletion(botA, token, ext.deps)).toBe("gone");
    await files.deleteBotBlobs({ id: botA, slug });
    expect(ext.projects.get(`bot-${slug}`)).toBe("prj_b");
    expect(ext.deleted).toEqual(["prj_a"]);
    expect(await files.completeFile(botB, fresh.fileId)).toBe(true);
    // The tombstone keeps A's identity for rejecting late callbacks without blocking B.
    expect(
      await rows("SELECT bot_id FROM bot_tombstones WHERE slug = $1", [slug])
    ).toEqual([{ bot_id: botA }]);
  });

  it("deletes a project an in-flight deploy recreated, by its new id, on the next attempt", async () => {
    const ext = externals();
    ext.projects.set(`bot-${slug}`, "prj_a");
    const recreate = ext.deps.deleteProjectById;
    ext.deps.deleteProjectById = async (id) => {
      await recreate(id);
      if (id === "prj_a") {
        ext.projects.set(`bot-${slug}`, "prj_a2");
      }
    };
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("failed");
    expect(
      await rows("SELECT deletion_project_id FROM bots WHERE id = $1", [botA])
    ).toEqual([{ deletion_project_id: "prj_a2" }]);
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");
    expect(ext.deleted).toEqual(["prj_a", "prj_a2"]);
  });

  it("waits for the bot's code tasks to stop before removing its row", async () => {
    const ext = externals();
    let pending = 1;
    ext.deps.requestBotCodeTaskShutdown = () => Promise.resolve({ pending });
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("failed");
    expect(await botRow(botA)).toBe(true);
    pending = 0;
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");
  });

  it("never moves to attention while code tasks are still confirming their stop", async () => {
    const ext = externals();
    ext.deps.requestBotCodeTaskShutdown = () => Promise.resolve({ pending: 1 });
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    for (let i = 0; i < deletion.DELETION_MAX_ATTEMPTS + 2; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Attempts are sequential by definition.
      await runDeletion(botA, token, ext.deps);
    }
    expect(
      await rows(
        "SELECT deletion_state, deletion_attempts, deletion_last_error FROM bots WHERE id = $1",
        [botA]
      )
    ).toEqual([
      {
        deletion_attempts: 0,
        deletion_last_error: `${deletion.NOT_READY_PREFIX}1 code tasks still stopping`,
        deletion_state: "deleting",
      },
    ]);
  });

  it("moves to attention after the attempt limit and re-arms on a new request", async () => {
    const ext = externals();
    ext.deps.deleteSchedules = () => Promise.reject(new Error("vercel down"));
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    for (let i = 0; i < deletion.DELETION_MAX_ATTEMPTS; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Attempts are sequential by definition.
      await runDeletion(botA, token, ext.deps);
    }
    expect(
      await rows(
        "SELECT deletion_state, deletion_attempts, deletion_last_error FROM bots WHERE id = $1",
        [botA]
      )
    ).toEqual([
      {
        deletion_attempts: deletion.DELETION_MAX_ATTEMPTS,
        deletion_last_error: "vercel down",
        deletion_state: "attention",
      },
    ]);
    // Not restarted by the cron, not a live bot either.
    await client.query(
      "UPDATE bots SET deletion_next_attempt_at = now() - interval '1 second'"
    );
    expect(await deletion.claimDueBotDeletions()).toEqual([]);
    expect(await deletion.requestBotDeletion(botA)).toEqual({
      start: true,
      token,
    });
    expect(
      await rows("SELECT deletion_state, deletion_attempts FROM bots")
    ).toContainEqual({ deletion_attempts: 0, deletion_state: "deleting" });
  });
});

describe("shared objects and deletion (N-06)", () => {
  async function readyFile(botId: string, botSlug = slug) {
    const reserved = await files.registerFile(
      asBot(botId, botSlug),
      upload,
      "user"
    );
    putSigned(reserved.uploadUrl);
    if (!(await files.completeFile(botId, reserved.fileId))) {
      throw new Error("fixture upload did not complete");
    }
    return reserved.fileId;
  }

  it("a promotion that loses to the deletion attaches nothing and leaves no object behind", async () => {
    const fileId = await readyFile(botA);
    let started: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    h.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.getStarted = started;
    // The promotion is hashing the upload when the bot is deleted.
    const promotion = objects.promoteVerifiedFile(botA, fileId);
    await reading;
    const ext = externals();
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");
    h.getGate = undefined;
    release();

    expect(await promotion).toBeNull();
    expect(await count("library_objects")).toBe(0);
  });

  it("a promotion that wins keeps the shared object for another bot and the GC collects it only when unreferenced", async () => {
    const fileA = await readyFile(botA);
    const fileC = await readyFile(botC, "helper");
    await objects.promoteVerifiedFile(botA, fileA);
    await objects.promoteVerifiedFile(botC, fileC);
    expect(await count("library_objects")).toBe(1);

    const ext = externals();
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");
    const [object] = await rows<{ pathname: string }>(
      "SELECT pathname FROM library_objects"
    );
    expect(object && h.store.has(object.pathname)).toBe(true);

    await client.query("DELETE FROM files WHERE bot_id = $1", [botC]);
    // The general sweep (cron) collects it once; a second sweep is a no-op.
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(1);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(0);
    expect(object && h.store.has(object.pathname)).toBe(false);
  });

  it("refuses a promotion for a bot marked deleting", async () => {
    const fileId = await readyFile(botA);
    await deletion.requestBotDeletion(botA);
    expect(await objects.promoteVerifiedFile(botA, fileId)).toBeNull();
    expect(
      await rows("SELECT object_id FROM files WHERE id = $1", [fileId])
    ).toEqual([{ object_id: null }]);
  });
});

describe("pending reservation expiry (H-37)", () => {
  const expire = (id: string) =>
    client.query(
      "UPDATE files SET pending_until = now() - interval '1 second' WHERE id = $1",
      [id]
    );

  it("keeps a recent reservation and expires an old one exactly once with its Blob", async () => {
    const recent = await files.registerFile(asBot(botA), upload, "user");
    const old = await files.registerFile(asBot(botA), upload, "user");
    putSigned(old.uploadUrl);
    await expire(old.fileId);
    const [deadline] = await rows<{ ok: boolean }>(
      "SELECT pending_until > now() + interval '59 minutes' AS ok FROM files WHERE id = $1",
      [recent.fileId]
    );
    expect(deadline?.ok).toBe(true);

    expect(await files.expirePendingFiles()).toBe(1);
    expect(await files.expirePendingFiles()).toBe(0);
    expect(h.store.has(pathOf(old.uploadUrl))).toBe(false);
    expect(await count("files", "id = $1", [old.fileId])).toBe(0);
    expect(await count("files", "id = $1", [recent.fileId])).toBe(1);
  });

  it("a completion past the deadline loses to the sweep; one inside it wins and is never swept", async () => {
    const late = await files.registerFile(asBot(botA), upload, "user");
    const onTime = await files.registerFile(asBot(botA), upload, "user");
    putSigned(late.uploadUrl);
    putSigned(onTime.uploadUrl);
    expect(await files.completeFile(botA, onTime.fileId)).toBe(true);
    await expire(late.fileId);
    await expire(onTime.fileId);

    expect(await files.completeFile(botA, late.fileId)).toBe(false);
    expect(await files.expirePendingFiles()).toBe(1);
    expect(
      await rows("SELECT status FROM files WHERE id = $1", [onTime.fileId])
    ).toEqual([{ status: "ready" }]);
    expect(h.store.has(pathOf(onTime.uploadUrl))).toBe(true);
  });

  it("a completion that checked the Blob before the deadline cannot publish after the sweep removed it", async () => {
    const reserved = await files.registerFile(asBot(botA), upload, "bot");
    putSigned(reserved.uploadUrl);
    // A bot artifact's completion reads the bytes (safety scan) after its HEAD; hold it there.
    let started: () => void = () => undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: () => void = () => undefined;
    h.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.getStarted = started;
    const completion = files.completeFile(botA, reserved.fileId);
    await reading;
    await expire(reserved.fileId);
    h.getGate = undefined;
    expect(await files.expirePendingFiles()).toBe(1);
    release();

    expect(await completion).toBe(false);
    expect(await count("files", "id = $1", [reserved.fileId])).toBe(0);
  });

  it("keeps the row for a retry when the Blob delete fails and never touches ready, blocked or stale rows", async () => {
    const reserved = await files.registerFile(asBot(botA), upload, "user");
    putSigned(reserved.uploadUrl);
    await expire(reserved.fileId);
    await client.query(
      `INSERT INTO files (bot_id, pathname, status, version, pending_until, stale_pathname, stale_until) VALUES
         ($1, 'bots/x/ready', 'ready', 10, now() - interval '1 day', NULL, NULL),
         ($1, 'bots/x/blocked', 'blocked', 11, now() - interval '1 day', 'bots/x/blocked', now() + interval '1 hour')`,
      [botA]
    );
    const blob = await import("@vercel/blob");
    vi.mocked(blob.del).mockRejectedValueOnce(new Error("blob unavailable"));

    expect(await files.expirePendingFiles()).toBe(0);
    expect(await count("files", "id = $1", [reserved.fileId])).toBe(1);
    expect(await files.expirePendingFiles()).toBe(1);
    expect(await count("files")).toBe(2);
  });

  it("spares a legacy path another row still names", async () => {
    const legacy = `bots/${slug}/1-notes.txt`;
    h.store.set(legacy, 4);
    await client.query(
      `INSERT INTO files (bot_id, pathname, status, version, pending_until) VALUES
         ($1, $3, 'pending', 20, now() - interval '1 second'),
         ($2, $3, 'ready', 1, NULL)`,
      [botA, botC, legacy]
    );
    expect(await files.expirePendingFiles()).toBe(1);
    expect(h.store.has(legacy)).toBe(true);
  });
});

describe("late upload of a deleted bot (H-09)", () => {
  it("cannot be completed by a new bot with the same slug", async () => {
    const late = await files.registerFile(asBot(botA), upload, "user");
    const ext = externals();
    const token = (await deletion.requestBotDeletion(botA))?.token ?? "";
    expect(await runDeletion(botA, token, ext.deps)).toBe("deleted");
    await client.query("INSERT INTO bots (id, slug) VALUES ($1, $2)", [
      botB,
      slug,
    ]);
    const fresh = await files.registerFile(asBot(botB), upload, "user");

    putSigned(late.uploadUrl);
    expect(await files.completeFile(botB, fresh.fileId)).toBe(false);
    // The late sweep of A removes the late bytes; B's reservation is untouched.
    await files.deleteBotBlobs({ id: botA, slug });
    expect(h.store.has(pathOf(late.uploadUrl))).toBe(false);
    expect(await count("files", "bot_id = $1", [botB])).toBe(1);
  });
});
