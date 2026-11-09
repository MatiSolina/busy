// Opt-in: starts a disposable local PostgreSQL server (needs `initdb` and
// `pg_ctl` on PATH) and is skipped otherwise:
//   BUSY_TEST_POSTGRES=1 pnpm exec vitest run apps/hub/lib/mcp/store.concurrency.test.ts --pool=forks
// PGlite has a single connection, so only a real server proves that the
// advisory lock serializes adds from separate connections.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it as test, vi } from "vitest";
import {
  baselineStatements,
  readMigrations,
} from "@/scripts/migration-database";

const state = vi.hoisted(() => ({ database: undefined as unknown }));

vi.mock("@/lib/db", async () => {
  const schema = await import("@/lib/db/schema");
  return { ...schema, db: () => state.database };
});

const CATALOG_ID = "github";
const CALLERS = 12;
const PORT = 40_000 + Math.floor(Math.random() * 20_000);
const available =
  process.env.BUSY_TEST_POSTGRES === "1" &&
  spawnSync("initdb", ["--version"]).status === 0 &&
  spawnSync("pg_ctl", ["--version"]).status === 0;

let dir = "";
let app: postgres.Sql | undefined;
let admin: postgres.Sql | undefined;

beforeAll(async () => {
  if (!available) {
    return;
  }
  dir = mkdtempSync(join(tmpdir(), "busy-mcp-pg-"));
  const data = join(dir, "data");
  execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust"], {
    stdio: "ignore",
  });
  execFileSync(
    "pg_ctl",
    [
      "-D",
      data,
      "-o",
      `-k ${dir} -c listen_addresses='' -p ${PORT}`,
      "-w",
      "start",
    ],
    { stdio: "ignore" }
  );
  const options = {
    database: "postgres",
    host: dir,
    port: PORT,
    user: "postgres",
  };
  admin = postgres({ ...options, max: 1, onnotice: () => undefined });
  await admin.unsafe("CREATE ROLE anon; CREATE ROLE authenticated;");
  for (const statement of await baselineStatements()) {
    // biome-ignore lint/performance/noAwaitInLoops: DDL order matters.
    await admin.unsafe(statement);
  }
  for (const migration of readMigrations()) {
    // biome-ignore lint/performance/noAwaitInLoops: migrations run in order.
    await admin.unsafe(migration.sql);
  }
  app = postgres({ ...options, max: CALLERS, onnotice: () => undefined });
  state.database = drizzle(app);
  process.env.SESSION_SECRET = "test-session-secret-0123456789";
}, 120_000);

afterAll(async () => {
  await app?.end();
  await admin?.end();
  if (dir) {
    spawnSync("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"]);
    rmSync(dir, { force: true, recursive: true });
  }
});

describe.skipIf(!available)("addConnection on PostgreSQL", () => {
  test("serializes concurrent adds from separate connections into one row", async () => {
    const { addConnection } = await import("./store");
    const gate = admin as postgres.Sql;
    const key = `busy:mcp:${CATALOG_ID}`;
    // Hold the store's lock key so every caller reaches it before any of them
    // can look for an existing row; then release them all at once.
    await gate`SELECT pg_advisory_lock(hashtext(${key}))`;
    const adds = Array.from({ length: CALLERS }, () =>
      addConnection(CATALOG_ID)
    );
    for (let waited = 0; ; waited += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: polls lock waiters.
      const [row] = await gate<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted`;
      if (row.waiting === CALLERS) {
        break;
      }
      if (waited > 500) {
        throw new Error(`only ${row.waiting} callers reached the lock`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await gate`SELECT pg_advisory_unlock(hashtext(${key}))`;

    const rows = await Promise.all(adds);
    expect(new Set(rows.map((row) => row?.id)).size).toBe(1);
    const [count] = await gate<{ count: number }[]>`
      SELECT count(*)::int AS count FROM mcp_connections WHERE catalog_id = ${CATALOG_ID}`;
    expect(count.count).toBe(1);
  }, 60_000);
});
