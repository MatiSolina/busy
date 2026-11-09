import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
// biome-ignore lint/performance/noNamespaceImport: Drizzle needs the full schema map, as in lib/db.
import * as schema from "../db/schema";

// The bots table as production had it before 0028 (no CREATE in drizzle/: it predates the SQL files).
const BOTS_TABLE = `
  CREATE TYPE bot_status AS ENUM ('creating', 'deploying', 'ready', 'failed');
  CREATE TABLE bots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug text NOT NULL,
    name text NOT NULL,
    avatar text,
    description text NOT NULL,
    instructions text NOT NULL DEFAULT '',
    model text NOT NULL DEFAULT 'moonshotai/kimi-k3',
    billing text NOT NULL DEFAULT 'gateway',
    fast boolean NOT NULL DEFAULT false,
    status bot_status NOT NULL DEFAULT 'creating',
    deployment_id text,
    url text,
    session_id text,
    live_until timestamptz,
    history_pending boolean NOT NULL DEFAULT false,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT bots_slug_unique UNIQUE (slug)
  );
`;

export const migration = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../drizzle/${name}`, import.meta.url)),
    "utf8"
  );

export const deployMigration = () =>
  migration("0028_bot_deploy_generation.sql");

/**
 * 0029's bots columns alone (its section 2): the rest of that file alters and links tables
 * (files, events, consultations...) that bots-only fixtures don't build.
 */
function deletionMigration() {
  const sql = migration("0029_bot_deletion_files.sql");
  const start = sql.indexOf("-- 2.");
  const end = sql.indexOf("-- 3.");
  if (start < 0 || end < start) {
    throw new Error("0029 no longer has sections 2 and 3");
  }
  return sql.slice(start, end);
}

/** Brings a fixture's pre-0028 bots table up to schema.ts with the real migrations. */
export const botsMigrations = () => deployMigration() + deletionMigration();

/** A PGlite bots table with the real 0028/0029 bots migrations applied (`beforeMigration` runs in between). */
export async function botsDatabase(
  beforeMigration?: (client: PGlite) => Promise<void>
) {
  const client = new PGlite();
  await client.exec(BOTS_TABLE);
  await beforeMigration?.(client);
  await client.exec(botsMigrations());
  return { client, database: drizzle(client, { schema }) };
}

export type BotsDatabase = Awaited<ReturnType<typeof botsDatabase>>["database"];
