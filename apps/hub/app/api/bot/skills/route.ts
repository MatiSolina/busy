import { catalogBot } from "@/lib/skills/bot-access";
import { installInputSchema, installSkillForBot } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function POST(req: Request) {
  try {
    const bot = await catalogBot(req);
    if (bot instanceof Response) {
      return bot;
    }
    const input = installInputSchema.safeParse(
      await req.json().catch(() => null)
    );
    if (!input.success) {
      return skillsJson(
        { error: "Provide a skills.sh id and snapshot hash." },
        400
      );
    }
    const installed = await installSkillForBot(input.data);
    return skillsJson(
      {
        capability: installed.capability,
        hash: installed.hash,
        reused: installed.reused,
      },
      installed.reused ? 200 : 201
    );
  } catch (error) {
    return skillsError(error);
  }
}
