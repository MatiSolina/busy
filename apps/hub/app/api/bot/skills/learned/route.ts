import { catalogBot } from "@/lib/skills/bot-access";
import { skillsError, skillsJson } from "@/lib/skills/http";
import { learnedSkillSchema, saveLearnedSkill } from "@/lib/skills/learned";

// The bot calls this only after the user tapped Save on its proposal (templates/bot/agent/tools/propose_skill.ts).
export async function POST(req: Request) {
  try {
    const bot = await catalogBot(req);
    if (bot instanceof Response) {
      return bot;
    }
    const input = learnedSkillSchema.safeParse(
      await req.json().catch(() => null)
    );
    if (!input.success) {
      return skillsJson(
        { error: input.error.issues[0]?.message ?? "Invalid skill." },
        400
      );
    }
    const saved = await saveLearnedSkill(input.data);
    return skillsJson(saved, saved.created ? 201 : 200);
  } catch (error) {
    return skillsError(error);
  }
}
