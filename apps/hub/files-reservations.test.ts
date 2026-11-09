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

// A fake private Blob store keyed by pathname: signed URLs name their path, a PUT lands on exactly
// that path, HEAD reports the stored size, and list/del work on prefixes and URLs.
const h = vi.hoisted(() => ({
  db: vi.fn(),
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
}));
vi.mock("./lib/db", () => ({
  bots: schema.bots,
  db: h.db,
  files: schema.files,
}));

const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const botB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const slug = "release-captain";
const size = 4;
let client: PGlite;
let files: typeof import("./lib/files");

const botRow = (id: string) => ({ id, slug }) as schema.BotRow;
const upload = { contentType: "text/plain", name: "notes.txt", size };

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (id uuid PRIMARY KEY, deletion_state text);
    INSERT INTO bots (id) VALUES ('${botA}'), ('${botB}');
    CREATE TABLE files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bot_id uuid NOT NULL,
      content_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      message_id uuid,
      name text NOT NULL,
      object_id uuid,
      pathname text NOT NULL,
      pending_until timestamptz,
      session_id text,
      size integer NOT NULL,
      source text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      stale_pathname text,
      stale_until timestamptz,
      turn_id text,
      version integer NOT NULL,
      UNIQUE (bot_id, name, version)
    );
  `);
  h.db.mockReturnValue(drizzle(client, { schema }));
  files = await import("./lib/files");
});

beforeEach(async () => {
  h.store.clear();
  await client.exec("DELETE FROM files");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      const stored = h.store.get(pathOf(url));
      if (init?.method === "HEAD") {
        return Promise.resolve(
          stored === undefined
            ? new Response(null, { status: 404 })
            : new Response(null, {
                headers: { "content-length": String(stored) },
              })
        );
      }
      return Promise.resolve(new Response("data"));
    })
  );
});

afterAll(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

const putSigned = (uploadUrl: string) => h.store.set(pathOf(uploadUrl), size);
const pathnameOf = async (id: string) =>
  (
    await client.query<{ pathname: string }>(
      "SELECT pathname FROM files WHERE id = $1",
      [id]
    )
  ).rows[0]?.pathname;

describe("reservation paths independent of the slug (H-09)", () => {
  it("derives the path from the bot id and the reservation id", async () => {
    const reserved = await files.registerFile(botRow(botA), upload, "user");
    // The name part also carries #197's hash of the full name.
    expect(await pathnameOf(reserved.fileId)).toMatch(
      new RegExp(
        `^bots/${botA}/${reserved.fileId}-[0-9a-f]{16}-notes\\.txt$`,
        "u"
      )
    );
    expect(pathOf(reserved.uploadUrl)).toBe(await pathnameOf(reserved.fileId));
  });

  it("never lets a late signed PUT of a deleted bot reach a new bot that reuses its slug", async () => {
    const late = await files.registerFile(botRow(botA), upload, "user");
    // Bot A is deleted (its rows go) and bot B takes the slug and reserves the same name.
    await client.query("DELETE FROM files WHERE bot_id = $1", [botA]);
    const fresh = await files.registerFile(botRow(botB), upload, "user");
    expect(await pathnameOf(fresh.fileId)).not.toBe(pathOf(late.uploadUrl));

    // A's URL is still valid and its PUT lands now, before B uploads anything.
    putSigned(late.uploadUrl);
    expect(await files.completeFile(botB, fresh.fileId)).toBe(false);

    // B's own bytes complete B's reservation; the late bytes stay under A's id prefix and A's
    // sweep removes them without touching B.
    putSigned(fresh.uploadUrl);
    expect(await files.completeFile(botB, fresh.fileId)).toBe(true);
    await files.deleteBotBlobs({ id: botA, slug });
    expect(h.store.has(pathOf(late.uploadUrl))).toBe(false);
    expect(h.store.has(pathOf(fresh.uploadUrl))).toBe(true);
  });

  it("gives two simultaneous reservations of one name distinct versions and paths", async () => {
    const [first, second] = await Promise.all([
      files.registerFile(botRow(botA), upload, "user"),
      files.registerFile(botRow(botA), upload, "bot"),
    ]);
    const rows = await client.query<{ pathname: string; version: number }>(
      "SELECT pathname, version FROM files ORDER BY version"
    );
    expect(rows.rows.map((row) => row.version)).toEqual([1, 2]);
    expect(new Set(rows.rows.map((row) => row.pathname)).size).toBe(2);
    expect(first?.uploadUrl).not.toBe(second?.uploadUrl);
  });

  it("keeps a legacy slug path while another bot's row references it and removes it once unreferenced", async () => {
    const legacy = `bots/${slug}/1-notes.txt`;
    const ownLegacy = `bots/${slug}/2-old.txt`;
    h.store.set(legacy, size);
    h.store.set(ownLegacy, size);
    // A pre-migration row of the bot that took the slug still names the legacy path.
    await client.query(
      `INSERT INTO files (bot_id, content_type, name, pathname, size, source, status, version)
       VALUES ($1, 'text/plain', 'notes.txt', $2, 4, 'user', 'ready', 1)`,
      [botB, legacy]
    );

    await files.deleteBotBlobs({ id: botA, slug });
    expect(h.store.has(legacy)).toBe(true);
    expect(h.store.has(ownLegacy)).toBe(false);

    // Once that reference moves on (promotion clears it after its stale window), a later sweep removes it.
    await client.query("DELETE FROM files WHERE bot_id = $1", [botB]);
    await files.deleteBotBlobs({ id: botA, slug });
    expect(h.store.has(legacy)).toBe(false);
  });

  it("reads and completes a legacy slug-based reservation by its stored path", async () => {
    const legacy = `bots/${slug}/3-notes.txt`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO files (bot_id, content_type, name, pathname, size, source, version)
       VALUES ($1, 'text/plain', 'notes.txt', $2, 4, 'user', 3) RETURNING id`,
      [botA, legacy]
    );
    const id = rows[0]?.id ?? "";
    h.store.set(legacy, size);
    expect(await files.completeFile(botA, id)).toBe(true);
    expect(await files.fileForMessage(botA, id)).toMatchObject({
      url: blobUrl(legacy),
    });
  });
});
