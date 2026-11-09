import { sectionError, sectionJson } from "@/lib/sections/http";
import { deleteSection, updateSection } from "@/lib/sections/store";
import {
  parseSectionId,
  parseUpdateSection,
  readSectionJson,
} from "@/lib/sections/validation";

interface Context {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const id = parseSectionId((await params).id);
    const input = parseUpdateSection(await readSectionJson(req));
    return sectionJson({ section: await updateSection(id, input.name) });
  } catch (error) {
    return sectionError(error);
  }
}

export async function DELETE(_req: Request, { params }: Context) {
  try {
    await deleteSection(parseSectionId((await params).id));
    return sectionJson({ ok: true });
  } catch (error) {
    return sectionError(error);
  }
}
