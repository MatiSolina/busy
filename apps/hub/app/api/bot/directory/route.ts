import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { botFromRequest } from "@/lib/bot-auth";
import { bots, db } from "@/lib/db";
import { need } from "@/lib/env";

// The peers a bot can consult, oldest first so slot N stays stable (plan task 4). The id breaks
// created_at ties, so the bot, the hub's sync and the app all see one total order (N-07). `id` is
// the stable identity the bot asks consultation credentials for; slug and url are routing only.
export async function GET(req: Request) {
  const bot = await botFromRequest(req);
  if (bot instanceof Response) {
    return bot;
  }
  const rows = await db()
    .select({
      description: bots.description,
      id: bots.id,
      name: bots.name,
      slug: bots.slug,
    })
    .from(bots)
    .where(
      and(
        eq(bots.status, "ready"),
        isNull(bots.deletionState),
        ne(bots.slug, bot.slug)
      )
    )
    .orderBy(asc(bots.createdAt), asc(bots.id));
  const domain = need("BOTS_DOMAIN");
  return Response.json(
    rows.map((r) => ({ ...r, url: `https://${r.slug}.${domain}` }))
  );
}
