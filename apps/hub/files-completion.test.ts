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
  issueSignedToken: vi.fn(),
  presignUrl: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({
  del: h.del,
  issueSignedToken: h.issueSignedToken,
  presignUrl: h.presignUrl,
}));
vi.mock("./lib/db", () => ({
  bots: schema.bots,
  db: h.db,
  files: schema.files,
}));

const botId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherBotId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fileId = "11111111-1111-4111-8111-111111111111";
const pathname = "bots/release-captain/3-video-de-prueba.mp4";
const size = 32_532;
let client: PGlite;
let files: typeof import("./lib/files");
let storedSize: number | null = size;
let compressedHead = false;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (id uuid PRIMARY KEY, deletion_state text);
    INSERT INTO bots (id) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    CREATE TABLE files (
      created_at timestamptz NOT NULL DEFAULT now(),
      pending_until timestamptz,
      content_type text NOT NULL DEFAULT 'application/octet-stream',
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      name text NOT NULL DEFAULT 'file.bin',
      pathname text NOT NULL,
      size integer NOT NULL,
      source text NOT NULL DEFAULT 'user',
      status text NOT NULL DEFAULT 'pending',
      stale_pathname text,
      stale_until timestamptz
    );
  `);
  h.db.mockReturnValue(drizzle(client, { schema }));
  files = await import("./lib/files");
});

beforeEach(async () => {
  vi.clearAllMocks();
  h.del.mockResolvedValue([]);
  storedSize = size;
  compressedHead = false;
  await client.exec("DELETE FROM files");
  await client.query(
    "INSERT INTO files (id, bot_id, pathname, size) VALUES ($1, $2, $3, $4)",
    [fileId, botId, pathname, size]
  );
  h.issueSignedToken.mockImplementation((options) =>
    Promise.resolve({ operations: options.operations })
  );
  h.presignUrl.mockImplementation((token, options) => {
    if (!token.operations.includes(options.operation)) {
      throw new Error("operation is not allowed by the signed token");
    }
    return Promise.resolve({
      presignedUrl: `https://blob.test/file?operation=${options.operation}`,
    });
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      // Blob signatures authorize one method: a GET URL cannot serve HEAD.
      const operation = new URL(url).searchParams.get("operation");
      if (operation !== (init?.method ?? "GET").toLowerCase()) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      if (
        compressedHead &&
        new Headers(init?.headers).get("accept-encoding") !== "identity"
      ) {
        return Promise.resolve(
          new Response(null, { headers: { "content-encoding": "br" } })
        );
      }
      return Promise.resolve(
        storedSize === null
          ? new Response(null, { status: 404 })
          : new Response(null, {
              headers: { "content-length": String(storedSize) },
            })
      );
    })
  );
});

afterAll(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

describe("uploaded file completion", () => {
  it("marks an uploaded MP4 ready after checking its signed metadata", async () => {
    expect(await files.completeFile(botId, fileId)).toBe(true);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("ready");
  });

  it("blocks a bot artifact with a credential-shaped text payload", async () => {
    await client.query(
      "UPDATE files SET content_type='text/plain', name='report.txt', source='bot' WHERE id=$1",
      [fileId]
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const operation = new URL(url).searchParams.get("operation");
        if (operation !== (init?.method ?? "GET").toLowerCase()) {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { headers: { "content-length": String(size) } })
          );
        }
        return Promise.resolve(
          new Response("API_KEY=fixture-secret7-value", {
            headers: { "content-length": String(size) },
          })
        );
      })
    );

    expect(await files.completeFile(botId, fileId)).toBe(false);
    const result = await client.query<{
      status: string;
      stale_pathname: string;
    }>("SELECT status, stale_pathname FROM files WHERE id=$1", [fileId]);
    expect(result.rows[0]).toEqual({
      stale_pathname: pathname,
      status: "blocked",
    });
  });

  it("does not revive a blocked file when its Blob deletion was unavailable", async () => {
    await client.query(
      "UPDATE files SET source='bot', status='blocked', stale_pathname=pathname WHERE id=$1",
      [fileId]
    );

    expect(await files.completeFile(botId, fileId)).toBe(false);
    expect(h.issueSignedToken).not.toHaveBeenCalled();
  });

  it.each(["text/plain", "application/octet-stream"])(
    "keeps a bot upload pending when its %s safety read is unavailable",
    async (contentType) => {
      await client.query(
        "UPDATE files SET content_type=$2, name='report.bin', source='bot' WHERE id=$1",
        [fileId, contentType]
      );
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: string, init?: RequestInit) => {
          if (init?.method === "HEAD") {
            return Promise.resolve(
              new Response(null, {
                headers: { "content-length": String(size) },
              })
            );
          }
          return Promise.reject(new Error("Storage temporarily unavailable"));
        })
      );

      expect(await files.completeFile(botId, fileId)).toBe(false);
      const result = await client.query<{ status: string }>(
        "SELECT status FROM files WHERE id=$1",
        [fileId]
      );
      expect(result.rows[0]?.status).toBe("pending");
      expect(h.del).not.toHaveBeenCalled();
    }
  );

  it("keeps an ordinary bot text report deliverable", async () => {
    await client.query(
      "UPDATE files SET content_type='text/plain', name='report.txt', source='bot' WHERE id=$1",
      [fileId]
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const operation = new URL(url).searchParams.get("operation");
        if (operation !== (init?.method ?? "GET").toLowerCase()) {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { headers: { "content-length": String(size) } })
          );
        }
        return Promise.resolve(
          new Response("The report discusses password rotation policy.", {
            headers: { "content-length": String(size) },
          })
        );
      })
    );

    expect(await files.completeFile(botId, fileId)).toBe(true);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("ready");
  });

  it("blocks a JSON bot report with a quoted credential key", async () => {
    await client.query(
      "UPDATE files SET content_type='application/json', name='report.json', source='bot' WHERE id=$1",
      [fileId]
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const operation = new URL(url).searchParams.get("operation");
        if (operation !== (init?.method ?? "GET").toLowerCase()) {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { headers: { "content-length": String(size) } })
          );
        }
        return Promise.resolve(
          new Response('{"password":"fixture-password7-value"}', {
            headers: { "content-length": String(size) },
          })
        );
      })
    );

    expect(await files.completeFile(botId, fileId)).toBe(false);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("blocked");
  });

  it("blocks plaintext credentials despite a binary MIME type and renamed extension", async () => {
    await client.query(
      "UPDATE files SET content_type='application/pdf', name='report.pdf', source='bot' WHERE id=$1",
      [fileId]
    );
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        const operation = new URL(url).searchParams.get("operation");
        if (operation !== (init?.method ?? "GET").toLowerCase()) {
          return Promise.resolve(new Response(null, { status: 403 }));
        }
        if (init?.method === "HEAD") {
          return Promise.resolve(
            new Response(null, { headers: { "content-length": String(size) } })
          );
        }
        return Promise.resolve(
          new Response("password=fixture-secret7-value", {
            headers: { "content-length": String(size) },
          })
        );
      })
    );

    expect(await files.completeFile(botId, fileId)).toBe(false);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("blocked");
  });

  it("verifies the original upload size when Blob would compress the HEAD response", async () => {
    compressedHead = true;
    expect(await files.completeFile(botId, fileId)).toBe(true);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("ready");
  });

  it.each([null, size - 1, size + 1])(
    "keeps a missing or differently sized upload pending (%s)",
    async (actualSize) => {
      storedSize = actualSize;
      expect(await files.completeFile(botId, fileId)).toBe(false);
      const result = await client.query<{ status: string }>(
        "SELECT status FROM files WHERE id=$1",
        [fileId]
      );
      expect(result.rows[0]?.status).toBe("pending");
    }
  );

  it("does not read or complete another bot's file", async () => {
    expect(await files.completeFile(otherBotId, fileId)).toBe(false);
    expect(h.issueSignedToken).not.toHaveBeenCalled();
  });

  it("accepts a completed file without checking storage again", async () => {
    await client.query("UPDATE files SET status='ready' WHERE id=$1", [fileId]);
    expect(await files.completeFile(botId, fileId)).toBe(true);
    expect(h.issueSignedToken).not.toHaveBeenCalled();
  });

  it("accepts concurrent completion retries after one request publishes the file", async () => {
    await client.query(
      "UPDATE files SET source='bot', content_type='text/plain', name='report.txt' WHERE id=$1",
      [fileId]
    );
    let heads = 0;
    let releaseHeads: () => void = () => undefined;
    const bothReadPending = new Promise<void>((resolve) => {
      releaseHeads = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") {
          heads += 1;
          if (heads === 2) {
            releaseHeads();
          }
          await bothReadPending;
          return new Response(null, {
            headers: { "content-length": String(size) },
          });
        }
        return new Response("An ordinary verified report.");
      })
    );

    expect(
      await Promise.all([
        files.completeFile(botId, fileId),
        files.completeFile(botId, fileId),
      ])
    ).toEqual([true, true]);
    const result = await client.query<{ status: string }>(
      "SELECT status FROM files WHERE id=$1",
      [fileId]
    );
    expect(result.rows[0]?.status).toBe("ready");
  });

  it("keeps normal download URLs scoped to GET", async () => {
    const url = await files.readUrl(pathname);
    expect(new URL(url).searchParams.get("operation")).toBe("get");
    expect(h.issueSignedToken).toHaveBeenCalledWith(
      expect.objectContaining({ operations: ["get"], pathname })
    );
  });
});
