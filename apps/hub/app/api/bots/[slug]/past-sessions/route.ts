import { getBot } from "@/lib/bots/service";
import { parsePastCursor, pastSessionsPage } from "@/lib/chat/initial";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const bot = await getBot(slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  const rawCursor = new URL(req.url).searchParams.get("before");
  const cursor = parsePastCursor(rawCursor);
  if (rawCursor !== null && !cursor) {
    return new Response("invalid cursor", { status: 400 });
  }
  return Response.json(
    {
      ...(await pastSessionsPage(bot.id, bot.sessionId, cursor)),
      sessionId: bot.sessionId,
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
