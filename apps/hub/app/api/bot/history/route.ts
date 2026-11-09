import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import {
  aroundHistory,
  historySearchLimits,
  searchHistory,
} from "@/lib/history-search";

const input = z.object({
  around: z.string().trim().max(240).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(historySearchLimits.maxResults)
    .default(historySearchLimits.defaultResults),
  q: z.string().trim().min(1).max(historySearchLimits.maxQueryLength),
});

/** Bot-only history API. The bot identity is taken from OIDC, never from query input. */
export async function GET(req: Request) {
  const callingBot = await botFromRequest(req);
  if (callingBot instanceof Response) {
    return callingBot;
  }
  const bot = await getBot(callingBot.slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  const parsed = input.safeParse(
    Object.fromEntries(new URL(req.url).searchParams)
  );
  if (!parsed.success) {
    return Response.json({ error: "Invalid history search" }, { status: 400 });
  }
  const { around, limit, q } = parsed.data;
  try {
    const results = await searchHistory(bot.id, q, { limit });
    if (!around) {
      return Response.json(
        { query: q, results },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const result = results.find((item) => item.id === around);
    if (!result) {
      return Response.json({ error: "result not found" }, { status: 404 });
    }
    return Response.json(
      { query: q, result: await aroundHistory(bot.id, result), results },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return Response.json(
      { error: "History search is unavailable. Try again." },
      { status: 503 }
    );
  }
}
