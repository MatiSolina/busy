import { sectionError, sectionJson } from "@/lib/sections/http";
import { createSection, listSections } from "@/lib/sections/store";
import { parseCreateSection, readSectionJson } from "@/lib/sections/validation";

export async function GET() {
  try {
    return sectionJson({ sections: await listSections() });
  } catch (error) {
    return sectionError(error);
  }
}

export async function POST(req: Request) {
  try {
    const input = parseCreateSection(await readSectionJson(req));
    return sectionJson({ section: await createSection(input.name) }, 201);
  } catch (error) {
    return sectionError(error);
  }
}
