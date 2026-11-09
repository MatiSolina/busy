import { catalogBot } from "@/lib/skills/bot-access";
import { previewSkill } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function GET(req: Request) {
  try {
    const bot = await catalogBot(req);
    if (bot instanceof Response) {
      return bot;
    }
    return skillsJson(
      await previewSkill(new URL(req.url).searchParams.get("id") ?? "")
    );
  } catch (error) {
    return skillsError(error);
  }
}
