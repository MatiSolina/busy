import { z } from "zod";
import { isSensitiveArtifactName } from "@/lib/artifact-safety";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import {
  chatFiles,
  fileInput,
  isBotUnavailable,
  registerFile,
} from "@/lib/files";
import { linkFileProvenance } from "@/lib/library-objects";

const input = z.object({
  contentType: z.string().max(200).default("application/octet-stream"),
  name: z.string().trim().min(1).max(fileInput.maxNameLength),
  size: z.number().int().positive().max(fileInput.maxBytes),
});

// send_file, step 1: a bot reserves a file for itself.
export async function POST(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid file" }, { status: 400 });
  }
  if (isSensitiveArtifactName(parsed.data.name)) {
    return Response.json(
      {
        error:
          "This file cannot be delivered because it may contain credentials.",
      },
      { status: 400 }
    );
  }
  const bot = await getBot(caller.slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  let reserved: Awaited<ReturnType<typeof registerFile>>;
  try {
    reserved = await registerFile(bot, parsed.data, "bot");
  } catch (error) {
    if (isBotUnavailable(error)) {
      return Response.json({ error: "bot is being deleted" }, { status: 409 });
    }
    throw error;
  }
  const requestedSession = req.headers.get("x-busy-session-id");
  await linkFileProvenance(bot.id, reserved.fileId, {
    sessionId:
      requestedSession && requestedSession === bot.sessionId
        ? requestedSession
        : null,
  });
  return Response.json(reserved);
}

// chat_files: the files of the calling bot's own chat.
export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const bot = await getBot(caller.slug);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  return Response.json(await chatFiles(bot.id));
}
