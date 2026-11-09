import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { lazyResult } from "../lib/lazy-tools";
import {
  installCatalogSkill,
  skillId,
  snapshotHash,
} from "../lib/skill-catalog";

// Consultations remain read-only; only a user conversation can change the app's shared skills.
export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) ? null : lazyResult("skills", ctx.view, tool)
);

const tool = defineTool({
  description:
    "Install a reviewed skills.sh skill in the Busy app for all bots when the user has authorized adding it. First call preview_skill and pass its exact hash. Persists in Busy and returns loadName for eve__skill. A search-only request does not authorize installation.",
  async execute({ id, hash }, ctx) {
    await Promise.resolve();
    if (isConsultation(ctx.session.auth)) {
      throw new Error(
        "Skills cannot be installed during a read-only consultation."
      );
    }
    return installCatalogSkill(id, hash, ctx.abortSignal);
  },
  inputSchema: z.object({ hash: snapshotHash, id: skillId }),
  label: { start: ({ id }) => `Install skill ${id}` },
});
