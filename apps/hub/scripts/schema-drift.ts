// What would `drizzle-kit push` do to a database built from the SQL migrations?
// Runs the real drizzle-kit CLI against a throwaway file-backed PGlite database
// (never a real one) and classifies the statements it proposes.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createMigratedDatabase } from "./migration-database";

const HUB_DIR = fileURLToPath(new URL("..", import.meta.url));
const SCHEMA = fileURLToPath(new URL("../lib/db/schema.ts", import.meta.url));
export const ALLOWLIST = fileURLToPath(
  new URL("./schema-drift-allowlist.txt", import.meta.url)
);
const HEADER = "You are about to execute current statements:";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "gu");
const BREAKPOINT = /\s*--> statement-breakpoint\s*/gu;
const WHITESPACE = /\s+/gu;
const STATEMENT = /^(?:ALTER|CREATE|DROP|COMMENT|GRANT|REVOKE|TRUNCATE)\b/u;
const DROP_CONSTRAINT = /DROP CONSTRAINT "(?<name>[^"]+)"/u;
// Statements that lose data or an invariant. They can never be approved: fix
// lib/db/schema.ts (or the migration) instead.
const FORBIDDEN = [
  /\bDROP COLUMN\b/iu,
  /\bDROP TABLE\b/iu,
  /\bSET DATA TYPE\b/iu,
  /\bDROP SCHEMA\b/iu,
];

export interface PushPlan {
  /** CHECK constraints present in the migrated database. */
  checks: Set<string>;
  /** Every statement drizzle-kit would run, whitespace-normalized. */
  statements: string[];
}

export interface DriftReport {
  /** Never acceptable: a column, table or CHECK would be lost. */
  forbidden: string[];
  /** In the allowlist but no longer proposed: remove them from the file. */
  stale: string[];
  /** Not in the allowlist: new drift between schema.ts and the migrations. */
  unapproved: string[];
}

const normalize = (statement: string) =>
  statement.replace(BREAKPOINT, " ").replace(WHITESPACE, " ").trim();

export async function pushPlan(extraSql = ""): Promise<PushPlan> {
  const dir = mkdtempSync(join(tmpdir(), "busy-schema-drift-"));
  try {
    const dataDir = join(dir, "db");
    const client = await createMigratedDatabase({ dataDir });
    if (extraSql) {
      await client.exec(extraSql);
    }
    const checks = await client.query<{ name: string }>(
      "SELECT conname AS name FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace"
    );
    await client.close();
    const config = join(dir, "drizzle.config.mjs");
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        dbCredentials: { url: dataDir },
        dialect: "postgresql",
        driver: "pglite",
        schema: SCHEMA,
      })};\n`
    );
    // --force only skips the prompt; the statements run on the throwaway copy.
    const result = spawnSync(
      "pnpm",
      [
        "exec",
        "drizzle-kit",
        "push",
        "--config",
        config,
        "--verbose",
        "--force",
      ],
      {
        cwd: HUB_DIR,
        encoding: "utf8",
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      }
    );
    const output = (result.stdout ?? "").replace(ANSI, "");
    if (result.status !== 0) {
      throw new Error(`drizzle-kit push failed:\n${output}\n${result.stderr}`);
    }
    const start = output.indexOf(HEADER);
    const statements =
      start === -1
        ? []
        : output
            .slice(start + HEADER.length)
            .split(";")
            .map(normalize)
            .filter((statement) => STATEMENT.test(statement))
            .map((statement) => `${statement};`);
    if (start === -1 && !output.includes("No changes detected")) {
      throw new Error(`Unexpected drizzle-kit output:\n${output}`);
    }
    return {
      checks: new Set(checks.rows.map((row) => row.name)),
      statements,
    };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

export function readAllowlist(path = ALLOWLIST): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(normalize);
}

export function classify(plan: PushPlan, allowlist: string[]): DriftReport {
  const approved = new Set(allowlist);
  const proposed = new Set(plan.statements);
  const isForbidden = (statement: string) =>
    FORBIDDEN.some((pattern) => pattern.test(statement)) ||
    plan.checks.has(statement.match(DROP_CONSTRAINT)?.groups?.name ?? "");
  return {
    forbidden: plan.statements.filter(isForbidden),
    stale: [...approved].filter((statement) => !proposed.has(statement)),
    unapproved: plan.statements.filter(
      (statement) => !(isForbidden(statement) || approved.has(statement))
    ),
  };
}
