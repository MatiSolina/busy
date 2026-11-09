import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { capabilityError, capabilityJson } from "@/lib/capabilities/http";
import { runtimeSkills } from "@/lib/capabilities/store";

export async function GET(req: Request) {
  try {
    const caller = await botFromRequest(req);
    if (caller instanceof Response) {
      return capabilityJson({ error: "unauthorized" }, caller.status);
    }
    const bot = await getBot(caller.slug);
    if (!bot) {
      return capabilityJson({ error: "Bot not found." }, 404);
    }
    return capabilityJson({ skills: await runtimeSkills() });
  } catch (error) {
    return capabilityError(error);
  }
}
