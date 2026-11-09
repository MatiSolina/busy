// Fails when `drizzle-kit push` against a database built from apps/hub/drizzle
// would drop a column, table or CHECK, or would change anything that is not in
// scripts/schema-drift-allowlist.txt. Offline: it uses a throwaway PGlite copy.
//   pnpm --filter hub check:schema
import { ALLOWLIST, classify, pushPlan, readAllowlist } from "./schema-drift";

const plan = await pushPlan();
const report = classify(plan, readAllowlist());
const sections: [string, string[]][] = [
  [
    "Would lose a column, table or CHECK (fix lib/db/schema.ts)",
    report.forbidden,
  ],
  [
    `Drift that is not approved in ${ALLOWLIST} (mirror the migration in lib/db/schema.ts)`,
    report.unapproved,
  ],
  ["Approved drift that no longer occurs (delete these lines)", report.stale],
];
let failed = false;
for (const [title, statements] of sections) {
  if (statements.length > 0) {
    failed = true;
    console.error(`\n${title}:`);
    for (const statement of statements) {
      console.error(`  ${statement}`);
    }
  }
}
if (failed) {
  process.exit(1);
}
console.log(
  `Schema and migrations agree (${plan.statements.length} approved legacy differences).`
);
