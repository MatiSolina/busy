// Dev: give every ready bot its single main session, the way refreshStatus does (operationId = bot id).
// Usage: DEV_RELAY_URL=https://app.busybot.dev pnpm exec tsx --env-file=.env.local scripts/main-sessions.ts
import { eq } from "drizzle-orm";
import { botCall } from "../lib/chat/store";
import { bots, db } from "../lib/db";
import { createSession } from "../lib/eve/client";

for (const bot of await db()
  .select()
  .from(bots)
  .where(eq(bots.status, "ready"))) {
  // biome-ignore lint/performance/noAwaitInLoops: Provision one bot at a time to avoid concurrent session creation against the relay.
  const sessionId = await createSession(botCall(bot.slug), bot.id);
  await db().update(bots).set({ sessionId }).where(eq(bots.id, bot.id));
  console.log(bot.slug, sessionId);
}
