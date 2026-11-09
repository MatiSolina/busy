import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
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
import { createMigratedDatabase } from "@/scripts/migration-database";

const state = vi.hoisted(() => ({
  database: undefined as unknown,
}));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  return { ...schema, db: () => state.database };
});

const HUB_ROOT = new URL("../../", import.meta.url).pathname;
const CATALOG_ID = "github";
const LEGACY_BOT = "11111111-1111-4111-8111-111111111111";
const OTHER_BOT = "22222222-2222-4222-8222-222222222222";
const SOURCE_FILE = /\.(?:ts|tsx|mts)$/u;
const TEST_FILE = /\.test\.(?:ts|tsx)$/u;
const SKIPPED_DIRS = new Set([".next", ".eve", ".output", "node_modules"]);

let client: PGlite;
let store: typeof import("./store");

async function snapshot(): Promise<string[]> {
  const result = await client.query<{ row: string }>(
    "SELECT row_to_json(m)::text AS row FROM mcp_connections m ORDER BY id"
  );
  return result.rows.map(({ row }) => row);
}

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
  client = await createMigratedDatabase();
  state.database = drizzle(client);
  store = await import("./store");
}, 60_000);

beforeEach(async () => {
  await client.exec("DELETE FROM mcp_connections; DELETE FROM bots;");
});

afterAll(async () => {
  await client.close();
});

describe("addConnection without a UNIQUE(catalog_id)", () => {
  it("returns one row for many concurrent adds of the same catalog id", async () => {
    // PGlite runs every transaction on one connection, so it serializes these
    // calls by itself; store.concurrency.test.ts repeats this on
    // PostgreSQL with separate connections, where the advisory lock decides.
    const rows = await Promise.all(
      Array.from({ length: 25 }, () => store.addConnection(CATALOG_ID))
    );
    const ids = new Set(rows.map((row) => row?.id));
    expect(ids.size).toBe(1);
    expect(ids.has(undefined)).toBe(false);
    const stored = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM mcp_connections WHERE catalog_id = $1",
      [CATALOG_ID]
    );
    expect(stored.rows[0].count).toBe(1);
  });

  it("keeps legacy duplicate grants byte for byte and returns the oldest", async () => {
    await client.query(
      `INSERT INTO bots (id, slug, name, description) VALUES
         ($1, 'legacy-a', 'Legacy A', ''), ($2, 'legacy-b', 'Legacy B', '')`,
      [LEGACY_BOT, OTHER_BOT]
    );
    await client.query(
      `INSERT INTO mcp_connections (id, bot_id, catalog_id, status, oauth_data, error, created_at, updated_at) VALUES
         ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', $1, $3, 'connected', 'v1.sealed-grant-a', NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', $2, $3, 'error', 'v1.sealed-grant-b', 'expired', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z')`,
      [LEGACY_BOT, OTHER_BOT, CATALOG_ID]
    );
    const before = await snapshot();

    const rows = await Promise.all([
      store.addConnection(CATALOG_ID),
      store.addConnection(CATALOG_ID),
      store.addConnection(CATALOG_ID),
    ]);

    expect(rows.map((row) => row?.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ]);
    expect(await snapshot()).toEqual(before);
    expect(await store.listConnections()).toHaveLength(2);
  });

  it("is the only application insert into mcp_connections", () => {
    const inserts: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (!SKIPPED_DIRS.has(name)) {
            visit(path);
          }
          continue;
        }
        if (!SOURCE_FILE.test(name) || TEST_FILE.test(name)) {
          continue;
        }
        const source = readFileSync(path, "utf8");
        const count =
          source.split("insert(mcpConnections)").length -
          1 +
          (source.match(/insert\s+into\s+"?(?:public\.)?mcp_connections/giu)
            ?.length ?? 0);
        for (let index = 0; index < count; index += 1) {
          inserts.push(relative(HUB_ROOT, path));
        }
      }
    };
    for (const dir of ["app", "lib", "workflows", "scripts"]) {
      visit(join(HUB_ROOT, dir));
    }
    expect(inserts).toEqual(["lib/mcp/store.ts"]);
    const source = readFileSync(join(HUB_ROOT, "lib/mcp/store.ts"), "utf8");
    const lock = source.indexOf("pg_advisory_xact_lock");
    const insert = source.indexOf("insert(mcpConnections)");
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(insert);
  });
});
