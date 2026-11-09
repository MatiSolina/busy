import { getBot } from "@/lib/bots/service";
import { installSkillForBot } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const bot = await getBot((await params).slug);
    if (!bot) {
      return skillsJson({ error: "Bot not found." }, 404);
    }
    const body = await req.json().catch(() => null);
    const installed = await installSkillForBot(
      body as { id: string; hash: string }
    );
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
