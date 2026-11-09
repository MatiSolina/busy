import { getBot } from "@/lib/bots/service";
import { botCall } from "@/lib/chat/store";
import { compactSession } from "@/lib/eve/client";

interface Ctx {
  params: Promise<{ slug: string }>;
}

// Compacts the bot's chat session now, so the user's next message doesn't wait for the summary.
export async function POST(_req: Request, { params }: Ctx) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  if (bot.status !== "ready" || !bot.sessionId) {
    return new Response("no session", { status: 409 });
  }
  try {
    await compactSession(botCall(bot.slug), bot.sessionId);
  } catch {
    // eve's error bodies can carry provider details: keep the response generic.
    return new Response("compact failed", { status: 502 });
  }
  return new Response(null, { status: 202 });
}

export const maxDuration = 30;
