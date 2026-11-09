import { installInputSchema, installSkillForBot } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

// Skill discovery and installation are app configuration. The reviewed
// snapshot is stored once and then exposed to every bot runtime.
export async function POST(req: Request) {
  try {
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
