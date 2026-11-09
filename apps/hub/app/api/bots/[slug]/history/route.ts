import { aiIssue, issueResponse } from "@/lib/ai/errors";
import { getBot } from "@/lib/bots/service";
import {
  aroundHistory,
  historySearchLimits,
  searchHistory,
} from "@/lib/history-search";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/** Search only the selected bot's primary conversation. Consultations are filtered in the query. */
export async function GET(req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  const query = new URL(req.url).searchParams;
  const text = query.get("q")?.trim() ?? "";
  if (!text || text.length > historySearchLimits.maxQueryLength) {
    return Response.json(
      {
        error: `q is required and limited to ${historySearchLimits.maxQueryLength} characters`,
      },
      { status: 400 }
    );
  }
  const requested = Number(
    query.get("limit") ?? historySearchLimits.defaultResults
  );
  if (
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > historySearchLimits.maxResults
  ) {
    return Response.json({ error: "Invalid search limit" }, { status: 400 });
  }
  const aroundId = query.get("around");
  if (aroundId && aroundId.length > 240) {
    return Response.json(
      { error: "Invalid history reference" },
      { status: 400 }
    );
  }
  try {
    const results = await searchHistory(bot.id, text, { limit: requested });
    if (!aroundId) {
      return Response.json(
        { query: text, results },
        { headers: { "Cache-Control": "private, no-store" } }
      );
    }
    const result = results.find((item) => item.id === aroundId);
    if (!result) {
      return Response.json({ error: "result not found" }, { status: 404 });
    }
    return Response.json(
      {
        query: text,
        result: await aroundHistory(bot.id, result),
        results,
      },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return Response.json(
      { error: "History search is unavailable. Try again." },
      { status: 503 }
    );
  }
}
