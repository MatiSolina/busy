// Initialize a Busy database exactly once. The target must have no public
// tables. The schema baseline and reviewed SQL migrations are applied in one
// transaction, so a failed setup rolls back instead of leaving a half-schema.
//
// Usage (from apps/hub):
//   NODE_OPTIONS=--env-file=.env.local pnpm db:init
//   NODE_OPTIONS=--env-file=.env.local pnpm db:init -- --dry-run
//   pnpm db:validate                 # offline PGlite validation
import postgres from "postgres";
import {
  baselineStatements,
  createMigratedDatabase,
  type Migration,
  readMigrations,
} from "./migration-database";

const args = new Set(process.argv.slice(2));
const ROLE_STATEMENTS = /\b(?:GRANT|REVOKE)\b[\s\S]*?;/giu;
const ROLE_TARGETS = /\b(?<direction>FROM|TO)\s+(?<roles>[^;]+);/iu;
const dryRun = args.has("--dry-run");
const validate = args.has("--validate");
const unknown = [...args].filter(
  (arg) => !["--dry-run", "--validate"].includes(arg)
);
if (unknown.length > 0 || (dryRun && validate)) {
  throw new Error("Usage: init-db.ts [--dry-run | --validate]");
}

if (validate) {
  const client = await createMigratedDatabase();
  await client.close();
  console.log(
    "Validated the empty-database baseline and all SQL migrations in PGlite."
  );
  process.exit(0);
}

const databaseUrl =
  process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL_UNPOOLED or DATABASE_URL is required");
}

const migrations = readMigrations();
const baseline = await baselineStatements(migrations);
const sql = postgres(databaseUrl, { max: 1, prepare: false });

interface RelationRow {
  relation_kind: string;
  relation_name: string;
}

interface RoleRow {
  rolname: string;
}

function relationLabel(row: RelationRow): string {
  let kind = "table";
  if (row.relation_kind === "v") {
    kind = "view";
  } else if (row.relation_kind === "m") {
    kind = "materialized view";
  }
  return `${row.relation_name} (${kind})`;
}

/**
 * Missing Supabase roles are safe to leave absent: no Data API role can then
 * access the schema. Migration REVOKE/GRANT statements mentioning an absent
 * role are reduced to the roles that exist (or omitted when none remain).
 */
function filterMissingRoles(source: string, missing: Set<string>): string {
  if (missing.size === 0) {
    return source;
  }
  return source.replace(ROLE_STATEMENTS, (statement) => {
    const match = statement.match(ROLE_TARGETS);
    if (!match) {
      return statement;
    }
    const roleList = match.groups?.roles;
    if (!roleList) {
      return statement;
    }
    const roles = roleList
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0)
      .filter((role) => !missing.has(role.toLowerCase()));
    if (roles.length === 0) {
      return `-- skipped ${statement.replace(/\s+/gu, " ").trim()} (role is not present)\n`;
    }
    return statement.replace(
      match[0],
      `${match.groups?.direction} ${roles.join(", ")};`
    );
  });
}

try {
  const relations = await sql<RelationRow[]>`
    SELECT c.relname AS relation_name, c.relkind AS relation_kind
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY c.relname
  `;
  if (relations.length > 0) {
    throw new Error(
      `Refusing to initialize a database that already has public relations: ${relations
        .map(relationLabel)
        .join(
          ", "
        )}. Use a new empty database or apply reviewed migrations manually.`
    );
  }

  const roles = await sql<RoleRow[]>`
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated')
  `;
  const presentRoles = new Set(roles.map(({ rolname }) => rolname));
  const missingRoles = new Set(
    ["anon", "authenticated"].filter((role) => !presentRoles.has(role))
  );
  const migrationSql = migrations.map((migration: Migration) => ({
    ...migration,
    sql: filterMissingRoles(migration.sql, missingRoles),
  }));

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          baselineStatements: baseline.length,
          migrations: migrationSql.map(({ name }) => name),
          missingRoles: [...missingRoles],
          publicRelations: 0,
        },
        null,
        2
      )
    );
    process.exit(0);
  }

  await sql.begin(async (transaction) => {
    for (const statement of baseline) {
      // biome-ignore lint/performance/noAwaitInLoops: DDL order is significant.
      await transaction.unsafe(statement);
    }
    for (const migration of migrationSql) {
      // biome-ignore lint/performance/noAwaitInLoops: migrations run in order.
      await transaction.unsafe(migration.sql);
    }
  });
  console.log(
    `Initialized the empty database with ${migrationSql.length} migrations.`
  );
} finally {
  await sql.end({ timeout: 5 });
}
