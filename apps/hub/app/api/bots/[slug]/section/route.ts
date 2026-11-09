import { sectionError, sectionJson } from "@/lib/sections/http";
import { setBotSection } from "@/lib/sections/store";
import { parseAssignSection, readSectionJson } from "@/lib/sections/validation";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function PUT(req: Request, { params }: Context) {
  try {
    const input = parseAssignSection(await readSectionJson(req));
    await setBotSection((await params).slug, input.sectionId);
    return sectionJson({ ok: true });
  } catch (error) {
    return sectionError(error);
  }
}
