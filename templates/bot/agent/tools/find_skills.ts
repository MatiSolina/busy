import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { lazyResult } from "../lib/lazy-tools";
import { findCatalogSkills } from "../lib/skill-catalog";

// The query leaves Busy for skills.sh, so a read-only consultation never gets this tool, and
// execution checks again for a call offered before the caller changed.
const tool = defineTool({
  description:
    "Search skills.sh for a specialized workflow when a task would benefit from expertise you do not yet have. Returns sources, install counts and skill ids. Search does not install anything.",
  execute: ({ query, owner }, ctx) => {
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Skill search is unavailable during a read-only consultation."
      );
    }
    return findCatalogSkills(query, owner, ctx.abortSignal);
  },
  inputSchema: z.object({
    owner: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u)
      .optional()
      .describe("Optional publisher filter, for example vercel-labs."),
    query: z.string().trim().min(2).max(120),
  }),
  label: { start: ({ query }) => `Find skills for ${query}` },
});

export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) ? null : lazyResult("skills", ctx.view, tool)
);
