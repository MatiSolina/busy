import { getBot } from "@/lib/bots/service";
import { consultationsOf } from "@/lib/chat/initial";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  return Response.json(await consultationsOf(bot.id));
}
