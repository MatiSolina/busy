// Dev: sync every ready bot's chat into Postgres once, through the relay.
// Usage: DEV_RELAY_URL=https://app.busybot.dev pnpm exec tsx --env-file=.env.local scripts/sync-once.ts
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { syncBot } from "../lib/chat/store";
import { bots, db, events } from "../lib/db";

for (const bot of await db()
  .select()
  .from(bots)
  .where(and(eq(bots.status, "ready"), isNotNull(bots.sessionId)))) {
  if (bot.sessionId === null) {
    continue;
  }
  // biome-ignore lint/performance/noAwaitInLoops: Keep each bot's stream sync and subsequent summary ordered, without flooding the relay.
  await syncBot(bot);
  const rows = await db()
    .select({ n: sql<number>`count(*)`, type: events.type })
    .from(events)
    .where(eq(events.sessionId, bot.sessionId))
    .groupBy(events.type);
  console.log(
    bot.slug,
    JSON.stringify(Object.fromEntries(rows.map((r) => [r.type, Number(r.n)])))
  );
}
