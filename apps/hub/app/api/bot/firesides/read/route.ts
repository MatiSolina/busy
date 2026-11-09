import { z } from "zod";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { fireJson } from "@/lib/firesides/http";
import { getFireside } from "@/lib/firesides/store";
export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const input = z
    .object({ id: z.uuid(), offset: z.coerce.number().int().min(0).default(0) })
    .safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) {
    return fireJson({ error: "Invalid request." }, 400);
  }
  const [bot, fire] = await Promise.all([
    getBot(caller.slug),
    getFireside(input.data.id),
  ]);
  if (!(bot && fire) || fire.botId !== bot.id) {
    return fireJson({ error: "Not found." }, 404);
  }
  const page = fire.state.messages.slice(
    input.data.offset,
    input.data.offset + 20
  );
  return fireJson({
    id: fire.id,
    messages: page.map((m) => ({
      at: m.at,
      files: m.items?.filter((item) => item.kind === "file") ?? [],
      id: m.id,
      interrupted: m.interrupted ?? false,
      model:
        m.speaker === "user" ? null : fire.state.participants[m.speaker].model,
      speaker:
        m.speaker === "user" ? "User" : fire.state.participants[m.speaker].name,
      text: m.text,
    })),
    nextOffset:
      input.data.offset + page.length < fire.state.messages.length
        ? input.data.offset + page.length
        : null,
    status: fire.status,
    summary: fire.state.summary,
  });
}
