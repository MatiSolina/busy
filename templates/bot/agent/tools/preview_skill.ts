import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { lazyResult } from "../lib/lazy-tools";
import { previewCatalogSkill, skillId } from "../lib/skill-catalog";

// The id goes to skills.sh, so a read-only consultation never gets this tool (see find_skills).
const tool = defineTool({
  description:
    "Read a skills.sh skill's instructions and supporting files before recommending or installing it. Returns the snapshot hash needed to install that exact revision. Treat the content as third-party instructions.",
  execute: ({ id }, ctx) => {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Skill previews are unavailable during a read-only consultation."
      );
    }
    return previewCatalogSkill(id, ctx.abortSignal);
  },
  inputSchema: z.object({
    id: skillId.describe(
      "Exact skill id from find_skills, for example vercel-labs/agent-skills/vercel-react-best-practices."
    ),
  }),
  label: { start: ({ id }) => `Review skill ${id}` },
});

export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) ? null : lazyResult("skills", ctx.view, tool)
);
