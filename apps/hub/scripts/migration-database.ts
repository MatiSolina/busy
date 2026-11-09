// Builds a throwaway PGlite database the way production got its schema: the
// tables that predate the SQL migrations come from the original `drizzle-kit
// push`, then every apps/hub/drizzle/*.sql file runs in order. Tests and the
// schema drift guard use it; nothing here connects to a real database.
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
// biome-ignore lint/performance/noNamespaceImport: drizzle-kit needs the whole schema map.
import * as schema from "../lib/db/schema";

const MIGRATIONS_DIR = new URL("../drizzle/", import.meta.url);
const CREATE_TABLE =
  /CREATE TABLE IF NOT EXISTS\s+(?:public\.)?"?(?<table>[a-z_][a-z0-9_]*)"?/giu;
const ALTER_TABLE =
  /ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(?<table>[a-z_][a-z0-9_]*)"?(?<body>[^;]*);/giu;
const ADD_COLUMN =
  /ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(?<column>[a-z_][a-z0-9_]*)"?/giu;

export interface Migration {
  name: string;
  sql: string;
}

export function readMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(new URL(name, MIGRATIONS_DIR), "utf8"),
    }));
}

interface SnapshotTable {
  checkConstraints: Record<string, unknown>;
  columns: Record<string, unknown>;
  compositePrimaryKeys: Record<string, { columns: string[] }>;
  foreignKeys: Record<string, { columnsFrom: string[]; tableTo: string }>;
  indexes: Record<
    string,
    { columns: { expression: string; isExpression: boolean }[] }
  >;
  name: string;
  uniqueConstraints: Record<string, { columns: string[] }>;
}

function keepWhere<T>(
  record: Record<string, T>,
  keep: (value: T) => boolean
): void {
  for (const [key, value] of Object.entries(record)) {
    if (!keep(value)) {
      delete record[key];
    }
  }
}

/**
 * DDL for the tables no SQL migration creates, as `drizzle-kit push` made them
 * before the migrations existed: without the columns, checks and foreign keys
 * that later migrations add. The migrations then add those with their real SQL.
 */
export async function baselineStatements(
  migrations: Migration[] = readMigrations()
): Promise<string[]> {
  const created = new Set<string>();
  const added = new Map<string, Set<string>>();
  for (const { sql } of migrations) {
    for (const match of sql.matchAll(CREATE_TABLE)) {
      created.add(String(match.groups?.table).toLowerCase());
    }
    for (const match of sql.matchAll(ALTER_TABLE)) {
      const table = String(match.groups?.table).toLowerCase();
      for (const column of String(match.groups?.body).matchAll(ADD_COLUMN)) {
        const columns = added.get(table) ?? new Set<string>();
        columns.add(String(column.groups?.column).toLowerCase());
        added.set(table, columns);
      }
    }
  }
  const snapshot = generateDrizzleJson(schema);
  const tables = snapshot.tables as unknown as Record<string, SnapshotTable>;
  const base = new Set(
    Object.values(tables)
      .map((table) => table.name)
      .filter((name) => !created.has(name))
  );
  keepWhere(tables, (table) => base.has(table.name));
  for (const table of Object.values(tables)) {
    for (const column of added.get(table.name) ?? []) {
      delete table.columns[column];
    }
    const present = (columns: string[]) =>
      columns.every((column) => column in table.columns);
    table.checkConstraints = {};
    keepWhere(
      table.foreignKeys,
      (fk) => base.has(fk.tableTo) && present(fk.columnsFrom)
    );
    keepWhere(table.uniqueConstraints, (unique) => present(unique.columns));
    keepWhere(table.compositePrimaryKeys, (pk) => present(pk.columns));
    keepWhere(table.indexes, (index) =>
      index.columns.every(
        (column) => column.isExpression || column.expression in table.columns
      )
    );
  }
  const empty = generateDrizzleJson({});
  return await generateMigration(empty, snapshot);
}

/** Supabase roles that the migrations REVOKE from; PGlite has none by default. */
const ROLES = "CREATE ROLE anon; CREATE ROLE authenticated;";

export interface MigratedDatabaseOptions {
  /** Directory for a file-backed database (needed by the drizzle-kit CLI). */
  dataDir?: string;
  /** Apply migrations up to and including this file name. */
  through?: string;
}

export async function createMigratedDatabase(
  options: MigratedDatabaseOptions = {}
): Promise<PGlite> {
  const migrations = readMigrations();
  const client = new PGlite(options.dataDir);
  await client.exec(ROLES);
  for (const statement of await baselineStatements(migrations)) {
    // biome-ignore lint/performance/noAwaitInLoops: DDL order matters.
    await client.exec(statement);
  }
  for (const migration of migrations) {
    if (options.through && migration.name > options.through) {
      break;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: migrations run in order.
      await client.exec(migration.sql);
    } catch (error) {
      throw new Error(`Migration ${migration.name} failed`, { cause: error });
    }
  }
  return client;
}

/** A database created only from lib/db/schema.ts, as a fresh `drizzle-kit push` would. */
export async function createSchemaDatabase(): Promise<PGlite> {
  const client = new PGlite();
  await client.exec(ROLES);
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(schema)
  )) {
    // biome-ignore lint/performance/noAwaitInLoops: DDL order matters.
    await client.exec(statement);
  }
  return client;
}
