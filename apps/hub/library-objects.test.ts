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

const h = vi.hoisted(() => ({
  db: vi.fn(),
  del: vi.fn(),
  put: vi.fn(),
  readUrl: vi.fn(),
  verifyFileBytes: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ del: h.del, put: h.put }));
vi.mock("@/lib/db", () => ({
  bots: schema.bots,
  db: h.db,
  files: schema.files,
  libraryObjects: schema.libraryObjects,
}));
vi.mock("./lib/files", () => ({
  READ_MINUTES: 10,
  readUrl: h.readUrl,
  verifyFileBytes: h.verifyFileBytes,
}));

const botA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const botB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fileA = "11111111-1111-4111-8111-111111111111";
const fileB = "22222222-2222-4222-8222-222222222222";
const hash = "a".repeat(64);
const LIBRARY_PATH_MATCH = /^library\/sha256\//u;

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let objects: typeof import("./lib/library-objects");
let canonicalAvailable = false;
let requireIdentityEncoding = false;

function blobResponse(url: string, init?: RequestInit) {
  if (init?.method !== "HEAD") {
    return Promise.resolve(new Response("same"));
  }
  if (
    requireIdentityEncoding &&
    new Headers(init.headers).get("accept-encoding") !== "identity"
  ) {
    return Promise.resolve(
      new Response(null, { headers: { "content-length": "0" } })
    );
  }
  if (new URL(url).searchParams.get("operation") !== "head") {
    return Promise.resolve(new Response(null, { status: 403 }));
  }
  return Promise.resolve(
    canonicalAvailable
      ? new Response(null, { headers: { "content-length": "4" } })
      : new Response(null, { status: 404 })
  );
}

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (id uuid PRIMARY KEY, deletion_state text);
    INSERT INTO bots (id) VALUES ('${botA}'), ('${botB}');
    CREATE TABLE library_objects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      content_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      pathname text NOT NULL UNIQUE,
      sha256 text NOT NULL UNIQUE,
      size integer NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      content_type text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      message_id uuid,
      name text NOT NULL,
      object_id uuid REFERENCES library_objects(id) ON DELETE RESTRICT,
      pathname text NOT NULL,
      session_id text,
      size integer NOT NULL,
      source text NOT NULL,
      status text NOT NULL DEFAULT 'ready',
      stale_pathname text,
      stale_until timestamptz,
      turn_id text,
      version integer NOT NULL
    );
  `);
  database = drizzle(client, { schema });
  h.db.mockReturnValue(database);
  h.readUrl.mockImplementation((_pathname: string, operation = "get") =>
    Promise.resolve(`https://blob.test/upload?operation=${operation}`)
  );
  h.verifyFileBytes.mockResolvedValue({ sha256: hash, size: 4 });
  h.del.mockResolvedValue([]);
  h.put.mockImplementation(() => {
    canonicalAvailable = true;
    return Promise.resolve({ url: "https://blob.test/library" });
  });
  vi.stubGlobal("fetch", vi.fn(blobResponse));
  vi.resetModules();
  objects = await import("./lib/library-objects");
});

beforeEach(async () => {
  await client.exec("DELETE FROM files; DELETE FROM library_objects;");
  vi.clearAllMocks();
  h.db.mockReturnValue(database);
  canonicalAvailable = false;
  requireIdentityEncoding = false;
  h.readUrl.mockImplementation((_pathname: string, operation = "get") =>
    Promise.resolve(`https://blob.test/upload?operation=${operation}`)
  );
  h.verifyFileBytes.mockResolvedValue({ sha256: hash, size: 4 });
  h.del.mockResolvedValue([]);
  h.put.mockImplementation(() => {
    canonicalAvailable = true;
    return Promise.resolve({ url: "https://blob.test/library" });
  });
  vi.stubGlobal("fetch", vi.fn(blobResponse));
});

afterAll(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

async function insertFile(id: string, botId: string, pathname: string) {
  await client.query(
    `INSERT INTO files (id, bot_id, content_type, name, pathname, size, source, status, version)
     VALUES ($1, $2, 'text/plain', $3, $4, 4, 'user', 'ready', 1)`,
    [id, botId, `${id}.txt`, pathname]
  );
}

describe("verified library promotion", () => {
  it("does not promote a blocked file from an old verification workflow", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await client.query("UPDATE files SET status = 'blocked' WHERE id = $1", [
      fileA,
    ]);

    await expect(objects.promoteVerifiedFile(botA, fileA)).resolves.toBeNull();
    expect(h.verifyFileBytes).not.toHaveBeenCalled();
  });

  it("checks the scoped file when provenance has no values", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");

    await expect(
      objects.linkFileProvenance(botA, fileA, { sessionId: null })
    ).resolves.toBe(true);
    await expect(objects.linkFileProvenance(botB, fileA, {})).resolves.toBe(
      false
    );
    await expect(objects.linkFileProvenance(botA, fileB, {})).resolves.toBe(
      false
    );
  });

  it("deduplicates two references while preserving the first canonical object", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await insertFile(fileB, botB, "bots/b/1-b.txt");

    await objects.promoteVerifiedFile(botA, fileA, { messageId: fileA });
    await objects.promoteVerifiedFile(botB, fileB, { messageId: fileB });

    const rows = await client.query<{ object_id: string; pathname: string }>(
      "SELECT object_id, pathname FROM files ORDER BY id"
    );
    expect(rows.rows[0]?.object_id).toBeTruthy();
    expect(rows.rows[1]?.object_id).toBe(rows.rows[0]?.object_id);
    expect(rows.rows[0]?.pathname).toMatch(LIBRARY_PATH_MATCH);
    expect(h.put).toHaveBeenCalledOnce();
  });

  it("leaves the reference usable when storage canonicalization fails and retries later", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    h.put.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(objects.promoteVerifiedFile(botA, fileA)).rejects.toThrow(
      "storage unavailable"
    );
    const pending = await client.query<{
      object_id: string | null;
      status: string;
    }>("SELECT object_id, status FROM files WHERE id = $1", [fileA]);
    expect(pending.rows[0]).toEqual({ object_id: null, status: "ready" });
    h.put.mockImplementation(() => {
      canonicalAvailable = true;
      return Promise.resolve({ url: "https://blob.test/library" });
    });
    await objects.promoteVerifiedFile(botA, fileA);
    const ready = await client.query<{ object_id: string | null }>(
      "SELECT object_id FROM files WHERE id = $1",
      [fileA]
    );
    expect(ready.rows[0]?.object_id).toBeTruthy();
  });

  it("verifies canonical storage with an identity-encoded HEAD", async () => {
    requireIdentityEncoding = true;
    await insertFile(fileA, botA, "bots/a/1-a.txt");

    await expect(
      objects.promoteVerifiedFile(botA, fileA)
    ).resolves.toMatchObject({
      pathname: expect.stringMatching(LIBRARY_PATH_MATCH),
    });
  });

  it("rebuilds a canonical Blob that disappeared while its metadata remained", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await objects.promoteVerifiedFile(botA, fileA);
    canonicalAvailable = false;
    await insertFile(fileB, botB, "bots/b/1-b.txt");
    await objects.promoteVerifiedFile(botB, fileB);
    const rows = await client.query<{ object_id: string | null }>(
      "SELECT object_id FROM files ORDER BY id"
    );
    expect(rows.rows[1]?.object_id).toBe(rows.rows[0]?.object_id);
    expect(h.put).toHaveBeenCalledTimes(2);
  });

  it("does not remove a shared object until every reference is gone", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await insertFile(fileB, botB, "bots/b/1-b.txt");
    await objects.promoteVerifiedFile(botA, fileA);
    await objects.promoteVerifiedFile(botB, fileB);
    await client.query("DELETE FROM files WHERE id = $1", [fileA]);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(0);
    await client.query("DELETE FROM files WHERE id = $1", [fileB]);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(1);
    expect(h.del).toHaveBeenCalledWith(
      expect.stringMatching(LIBRARY_PATH_MATCH)
    );
  });

  it("revalidates an orphan candidate under the digest lock and keeps a reference attached after listing", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await objects.promoteVerifiedFile(botA, fileA);
    const [{ object_id: objectId } = { object_id: "" }] = (
      await client.query<{ object_id: string }>(
        "SELECT object_id FROM files WHERE id = $1",
        [fileA]
      )
    ).rows;
    await client.query("DELETE FROM files WHERE id = $1", [fileA]);

    // The sweep lists the object as an orphan; before its locked revalidation runs, another bot's
    // reference is attached to the same object (what a racing promotion commits).
    let releaseCollect: () => void = () => undefined;
    const collectGate = new Promise<void>((resolve) => {
      releaseCollect = resolve;
    });
    let listed: () => void = () => undefined;
    const candidatesListed = new Promise<void>((resolve) => {
      listed = resolve;
    });
    h.db.mockReturnValue(
      new Proxy(database, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return async (...args: Parameters<typeof database.transaction>) => {
              listed();
              await collectGate;
              return await target.transaction(...args);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      })
    );
    const sweep = objects.deleteOrphanedLibraryObjects();
    await candidatesListed;
    await client.query(
      `INSERT INTO files (id, bot_id, content_type, name, object_id, pathname, size, source, status, version)
       SELECT $1, $2, 'text/plain', 'b.txt', id, pathname, 4, 'user', 'ready', 1 FROM library_objects WHERE id = $3`,
      [fileB, botB, objectId]
    );
    releaseCollect();

    expect(await sweep).toBe(0);
    expect(h.del).not.toHaveBeenCalled();
    const kept = await client.query("SELECT id FROM library_objects");
    expect(kept.rows).toHaveLength(1);

    // A second sweep after the last reference goes collects it once; a third is a no-op.
    h.db.mockReturnValue(database);
    await client.query("DELETE FROM files WHERE id = $1", [fileB]);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(1);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(0);
    expect(h.del).toHaveBeenCalledOnce();
  });

  it("keeps an orphan object and its row when the Blob delete fails, then retries", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await objects.promoteVerifiedFile(botA, fileA);
    await client.query("DELETE FROM files WHERE id = $1", [fileA]);
    h.del.mockRejectedValueOnce(new Error("blob unavailable"));

    expect(await objects.deleteOrphanedLibraryObjects()).toBe(0);
    expect(
      (await client.query("SELECT id FROM library_objects")).rows
    ).toHaveLength(1);
    expect(await objects.deleteOrphanedLibraryObjects()).toBe(1);
  });

  it("keeps a promoted upload until its pre-promotion read URL expires", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");

    await objects.promoteVerifiedFile(botA, fileA);

    expect(h.del).not.toHaveBeenCalled();
    const promoted = await client.query<{
      pathname: string;
      stale_pathname: string | null;
      stale_until: string | null;
    }>(
      "SELECT pathname, stale_pathname, stale_until FROM files WHERE id = $1",
      [fileA]
    );
    expect(promoted.rows[0]?.pathname).toMatch(LIBRARY_PATH_MATCH);
    expect(promoted.rows[0]?.stale_pathname).toBe("bots/a/1-a.txt");
    expect(promoted.rows[0]?.stale_until).toBeTruthy();

    const removed = await objects.deleteExpiredStaleUploads(
      new Date(Date.now() + 10 * 60_000 + 1)
    );
    expect(removed).toBe(1);
    expect(h.del).toHaveBeenCalledWith("bots/a/1-a.txt");
    const cleared = await client.query<{
      stale_pathname: string | null;
      stale_until: string | null;
    }>("SELECT stale_pathname, stale_until FROM files WHERE id = $1", [fileA]);
    expect(cleared.rows[0]).toEqual({
      stale_pathname: null,
      stale_until: null,
    });
  });

  it("keeps an expired upload queued when Blob deletion fails", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await objects.promoteVerifiedFile(botA, fileA);
    h.del.mockRejectedValueOnce(new Error("blob unavailable"));

    const now = new Date(Date.now() + 10 * 60_000 + 1);
    expect(await objects.deleteExpiredStaleUploads(now)).toBe(0);
    const pending = await client.query<{
      stale_pathname: string | null;
      stale_until: string | null;
    }>("SELECT stale_pathname, stale_until FROM files WHERE id = $1", [fileA]);
    expect(pending.rows[0]?.stale_pathname).toBe("bots/a/1-a.txt");
    expect(pending.rows[0]?.stale_until).toBeTruthy();

    expect(await objects.deleteExpiredStaleUploads(now)).toBe(1);
    expect(h.del).toHaveBeenLastCalledWith("bots/a/1-a.txt");
  });

  it("cleans a blocked upload tombstone without treating its own row as a reference", async () => {
    await insertFile(fileA, botA, "bots/a/1-a.txt");
    await client.query(
      "UPDATE files SET status = 'blocked', stale_pathname = pathname, stale_until = now() WHERE id = $1",
      [fileA]
    );

    expect(await objects.deleteExpiredStaleUploads(new Date())).toBe(1);
    expect(h.del).toHaveBeenCalledWith("bots/a/1-a.txt");
    const cleared = await client.query<{
      stale_pathname: string | null;
      stale_until: string | null;
    }>("SELECT stale_pathname, stale_until FROM files WHERE id = $1", [fileA]);
    expect(cleared.rows[0]).toEqual({
      stale_pathname: null,
      stale_until: null,
    });
  });
});
