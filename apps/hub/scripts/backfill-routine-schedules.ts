// Create (or repair) the Vercel schedule of every live routine. Idempotent: safe to rerun.
// Production: VERCEL_TOKEN, VERCEL_TEAM_ID and DATABASE_URL from .env.local, project from .vercel/project.json:
//   pnpm exec tsx --env-file=.env.local scripts/backfill-routine-schedules.ts
// Outside a deployment the SDK takes an access token, which needs projectId/teamId on every request
// (https://vercel.com/docs/schedules/http-api#authentication). Without `env` it targets production.
import { readFileSync } from "node:fs";
import { SchedulesClient } from "@vercel/schedules";
import { isNull } from "drizzle-orm";
import { db, routines } from "../lib/db";
import { syncRoutineSchedule } from "../lib/routines/schedule";

const { projectId } = JSON.parse(
  readFileSync(new URL("../.vercel/project.json", import.meta.url), "utf8")
) as { projectId: string };
const token = process.env.VERCEL_TOKEN;
const teamId = process.env.VERCEL_TEAM_ID;
if (!(token && teamId)) {
  throw new Error("VERCEL_TOKEN and VERCEL_TEAM_ID are required.");
}
const client = new SchedulesClient({
  fetch: (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    url.searchParams.set("projectId", projectId);
    url.searchParams.set("teamId", teamId);
    return fetch(url, init);
  },
  token,
});

const rows = await db()
  .select()
  .from(routines)
  .where(isNull(routines.deletedAt));
for (const row of rows) {
  // biome-ignore lint/performance/noAwaitInLoops: Sequential keeps well under the API's rate limits.
  await syncRoutineSchedule(row, client);
  console.log(
    `synced routine ${row.id} (bot ${row.botId}, ${row.enabled ? "enabled" : "paused"})`
  );
}
console.log(`${rows.length} routine schedule(s) in sync.`);
process.exit(0);
