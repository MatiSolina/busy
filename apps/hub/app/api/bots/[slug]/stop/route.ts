import { z } from "zod";
import { aiIssue, issueResponse } from "@/lib/ai/errors";
import { getBot } from "@/lib/bots/service";
import { botCall } from "@/lib/chat/store";
import { cancelTurn } from "@/lib/eve/client";

interface Ctx {
  params: Promise<{ slug: string }>;
}

// Cancels only the turn the app is showing (spec 4.3).
export async function POST(req: Request, { params }: Ctx) {
  const parsed = z
    .object({ turnId: z.string().min(1).max(100) })
    .safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return issueResponse(aiIssue("invalid_data"), 400);
  }
  const bot = await getBot((await params).slug);
  if (!bot?.sessionId) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  await cancelTurn(botCall(bot.slug), bot.sessionId, parsed.data.turnId);
  return Response.json({ ok: true });
}
