import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { planRecoveryForSession } from "@/lib/chat/plan-recovery";

const query = z.strictObject({
  sessionId: z.string().trim().min(1).max(200),
});
const headers = { "Cache-Control": "no-store" };

/** Only a server-owned recovery record can provide a replacement root's plan. */
export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const parameters = new URL(req.url).searchParams;
  const parsed = query.safeParse(Object.fromEntries(parameters));
  if (!parsed.success || parameters.getAll("sessionId").length !== 1) {
    return Response.json(
      { error: "Invalid session identity." },
      { headers, status: 400 }
    );
  }

  try {
    const bot = await getBot(caller.slug);
    if (!bot) {
      return Response.json(
        { error: "Bot not found." },
        { headers, status: 404 }
      );
    }
    const packet = await planRecoveryForSession(bot.id, parsed.data.sessionId);
    return Response.json(packet, { headers });
  } catch {
    return Response.json(
      { error: "The saved recovery state is temporarily unavailable." },
      { headers, status: 503 }
    );
  }
}
