import { start } from "workflow/api";
import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { completeFile } from "@/lib/files";
import { linkFileProvenance } from "@/lib/library-objects";
import { verifyFileWorkflow } from "@/workflows/verify-file";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const id = z.uuid().safeParse((await params).id);
  const bot = await getBot(caller.slug);
  if (!(id.success && bot)) {
    return new Response("not found", { status: 404 });
  }
  if (!(await completeFile(bot.id, id.data))) {
    return new Response("not found", { status: 404 });
  }
  const requestedSession = req.headers.get("x-busy-session-id");
  await linkFileProvenance(bot.id, id.data, {
    sessionId:
      requestedSession && requestedSession === bot.sessionId
        ? requestedSession
        : null,
  });
  await start(verifyFileWorkflow, [bot.id, id.data]).catch(() => {
    // The library verification cron retries ready files whose object_id is null.
  });
  return Response.json({ ok: true, status: "ready", verification: "queued" });
}
