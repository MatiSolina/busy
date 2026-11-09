import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { skillsJson } from "./http";

/** Derive ownership from the verified project identity, never a request body. */
export async function catalogBot(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return skillsJson({ error: "Unauthorized." }, caller.status);
  }
  const bot = await getBot(caller.slug);
  return bot ?? skillsJson({ error: "Bot not found." }, 404);
}
