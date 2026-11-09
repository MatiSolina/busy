import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { fileForMessage } from "@/lib/files";

interface Ctx {
  params: Promise<{ id: string }>;
}

// chat_files: a short-lived download link for one of the calling bot's own files.
export async function GET(req: Request, { params }: Ctx) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const id = z.uuid().safeParse((await params).id);
  const bot = await getBot(caller.slug);
  if (!(id.success && bot)) {
    return new Response("not found", { status: 404 });
  }
  const file = await fileForMessage(bot.id, id.data).catch(() => null);
  return file
    ? Response.json(file)
    : new Response("not found", { status: 404 });
}
