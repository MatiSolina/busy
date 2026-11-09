// Link every bot to its Vercel project (bots.vercel_project_id, migration 0028). Idempotent: safe
// to rerun. A row is linked only when the team project `bot-<slug>` holds the bot's own recorded
// deployment; everything else is reported and left unlinked. Needs VERCEL_TOKEN, VERCEL_TEAM_ID and
// DATABASE_URL. Dry run first (prints what it would link, writes nothing):
//   pnpm exec tsx --env-file=.env.local scripts/backfill-bot-project-ids.ts --dry-run
//   pnpm exec tsx --env-file=.env.local scripts/backfill-bot-project-ids.ts
import { backfillBotProjectIds } from "../lib/bots/project-backfill";
import { findProject, getDeploymentProjectId } from "../lib/vercel/client";

const token = process.env.VERCEL_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;
if (!(token && teamId)) {
  throw new Error("VERCEL_TOKEN and VERCEL_TEAM_ID are required.");
}
const cfg = { teamId, token };
const dryRun = process.argv.includes("--dry-run");

const report = await backfillBotProjectIds(
  {
    findProject: (name) => findProject(cfg, name),
    getDeploymentProjectId: (id) => getDeploymentProjectId(cfg, id),
  },
  { dryRun }
);
for (const { outcome, slug } of report) {
  console.log(`${outcome.padEnd(14)} ${slug}`);
}
const unlinked = report.filter(
  (r) => r.outcome !== "linked" && r.outcome !== "already-linked"
).length;
console.log(
  `${report.length} unlinked bot(s) checked${dryRun ? " (dry run)" : ""}; ${unlinked} still unlinked.`
);
process.exit(0);
