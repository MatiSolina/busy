import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMigratedDatabase,
  createSchemaDatabase,
  readMigrations,
} from "./migration-database";
import { classify, pushPlan, readAllowlist } from "./schema-drift";

const PARITY_MIGRATION = "0025_state_checks.sql";
const ROWS_OUTSIDE =
  /bots_billing_check .* 1 existing row\(s\) are outside the allowed values/u;
const DIFFERENT_DEFINITION = /files_status_check on files already exists/u;
const parity = () => {
  const migration = readMigrations().find(
    (file) => file.name === PARITY_MIGRATION
  );
  if (!migration) {
    throw new Error(`${PARITY_MIGRATION} is missing`);
  }
  return migration.sql;
};

async function checks(client: PGlite) {
  const result = await client.query<{ check: string }>(
    `SELECT c.conrelid::regclass::text || '.' || c.conname || ' ' ||
            pg_get_constraintdef(c.oid) AS check
     FROM pg_constraint AS c
     WHERE c.contype = 'c' AND c.connamespace = 'public'::regnamespace
     ORDER BY 1`
  );
  return result.rows.map((row) => row.check);
}

async function columns(client: PGlite) {
  const result = await client.query<{ column: string }>(
    `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' ||
            is_nullable || ' ' || coalesce(column_default, '-') AS column
     FROM information_schema.columns
     WHERE table_schema = 'public'
     ORDER BY 1`
  );
  return result.rows.map((row) => row.column);
}

describe("drizzle-kit push against the migrated database", () => {
  it("proposes no dropped column, table or CHECK and only approved drift", async () => {
    const report = classify(await pushPlan(), readAllowlist());
    expect(report).toEqual({ forbidden: [], stale: [], unapproved: [] });
  }, 120_000);

  it("flags a migration that schema.ts does not mirror", async () => {
    const plan = await pushPlan(`
      ALTER TABLE public.messages ADD COLUMN unmirrored text;
      ALTER TABLE public.bots ADD CONSTRAINT bots_unmirrored_check CHECK (length(name) > 0);
    `);
    const report = classify(plan, readAllowlist());
    expect(report.forbidden).toEqual(
      expect.arrayContaining([
        'ALTER TABLE "messages" DROP COLUMN "unmirrored";',
        'ALTER TABLE "bots" DROP CONSTRAINT "bots_unmirrored_check";',
      ])
    );
  }, 120_000);
});

describe("schema.ts and the SQL migrations", () => {
  let migrated: PGlite;
  let fromSchema: PGlite;

  beforeAll(async () => {
    migrated = await createMigratedDatabase();
    fromSchema = await createSchemaDatabase();
  }, 60_000);

  afterAll(async () => {
    await migrated.close();
    await fromSchema.close();
  });

  it("define the same CHECK constraints, by name and definition", async () => {
    expect(await checks(fromSchema)).toEqual(await checks(migrated));
  });

  it("define the same columns, types, nullability and defaults", async () => {
    expect(await columns(fromSchema)).toEqual(await columns(migrated));
  });

  it("accept every migration on a fresh `drizzle-kit push` database", async () => {
    // A new installation pushes the schema to an empty database and then
    // applies all migrations for RLS, grants and SQL-only indexes.
    const before = await checks(fromSchema);
    for (const migration of readMigrations()) {
      // biome-ignore lint/performance/noAwaitInLoops: migrations run in order.
      await fromSchema.exec(migration.sql);
    }
    expect(await checks(fromSchema)).toEqual(before);
  });

  it("can re-run the parity migration on either database", async () => {
    const before = await checks(migrated);
    await migrated.exec(parity());
    await fromSchema.exec(parity());
    expect(await checks(migrated)).toEqual(before);
    expect(await checks(fromSchema)).toEqual(before);
  });
});

describe(PARITY_MIGRATION, () => {
  it("stops before adding a CHECK that existing rows violate", async () => {
    const client = await createMigratedDatabase({
      through: "0024_routine_next_run_nullable.sql",
    });
    await client.exec(`
      INSERT INTO bots (id, slug, name, description, billing)
      VALUES ('11111111-1111-4111-8111-111111111111', 'legacy', 'Legacy', '', 'prepaid');
    `);
    await expect(client.exec(parity())).rejects.toThrow(ROWS_OUTSIDE);
    const bot = await client.query<{ billing: string }>(
      "SELECT billing FROM bots"
    );
    expect(bot.rows).toEqual([{ billing: "prepaid" }]);
    const added = await client.query(
      "SELECT 1 FROM pg_constraint WHERE conname = 'bots_billing_check'"
    );
    expect(added.rows).toHaveLength(0);
    await client.close();
  }, 60_000);

  it("refuses a same-named CHECK with a different definition", async () => {
    const client = await createMigratedDatabase({
      through: "0024_routine_next_run_nullable.sql",
    });
    await client.exec(`
      ALTER TABLE files ADD CONSTRAINT files_status_check
        CHECK (status IN ('pending', 'ready'));
    `);
    await expect(client.exec(parity())).rejects.toThrow(DIFFERENT_DEFINITION);
    await client.close();
  }, 60_000);

  it("adds selected_skills and its checks where 0020 never ran", async () => {
    const client = await createMigratedDatabase({
      through: "0019_library_objects.sql",
    });
    await client.exec(parity());
    const added = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages' AND column_name IN ('selected_skills', 'client_context', 'payload_hash')
       ORDER BY 1`
    );
    expect(added.rows.map((row) => row.column_name)).toEqual([
      "client_context",
      "payload_hash",
      "selected_skills",
    ]);
    const names = await client.query<{
      conname: string;
      convalidated: boolean;
    }>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conrelid = 'messages'::regclass AND contype = 'c' ORDER BY 1`
    );
    expect(names.rows).toEqual([
      { conname: "messages_payload_hash_check", convalidated: true },
      { conname: "messages_selected_skills_array_check", convalidated: true },
    ]);
    await client.close();
  }, 60_000);
});
