import { previewSkill } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("id") ?? "";
    return skillsJson(await previewSkill(id));
  } catch (error) {
    return skillsError(error);
  }
}
