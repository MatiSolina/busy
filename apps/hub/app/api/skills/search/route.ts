import { searchSkills } from "@/lib/skills/catalog";
import { skillsError, skillsJson } from "@/lib/skills/http";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const query = url.searchParams.get("q") ?? "";
    const owner = url.searchParams.get("owner") ?? undefined;
    const rawLimit = url.searchParams.get("limit");
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    const skills = await searchSkills(query, owner, limit, {});
    return skillsJson({ skills });
  } catch (error) {
    return skillsError(error);
  }
}
