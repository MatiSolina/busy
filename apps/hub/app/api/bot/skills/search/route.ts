import { catalogBot } from "@/lib/skills/bot-access";
import { searchSkills } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function GET(req: Request) {
  try {
    const bot = await catalogBot(req);
    if (bot instanceof Response) {
      return bot;
    }
    const params = new URL(req.url).searchParams;
    const rawLimit = params.get("limit");
    return skillsJson({
      skills: await searchSkills(
        params.get("q") ?? "",
        params.get("owner") ?? undefined,
        rawLimit === null ? undefined : Number(rawLimit)
      ),
    });
  } catch (error) {
    return skillsError(error);
  }
}
