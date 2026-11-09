import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import {
  enabledGroups,
  groupsFor,
  LAZY_LEVEL,
  LAZY_TOOLS,
  type LazyGroup,
  type LazyLevel,
} from "../lib/lazy-tools";

export function enableTools(level: LazyLevel) {
  const descriptions = groupsFor(level);
  const groups = Object.keys(descriptions) as [LazyGroup, ...LazyGroup[]];
  const tool = defineTool({
    description: `Load tool groups that are not in your tool list yet. They appear from your next step and stay for the rest of this conversation. Call it before the first use of a group; calling it again is harmless. Groups:\n${groups
      .map((g) => `- ${g}: ${descriptions[g]}`)
      .join("\n")}`,
    execute: ({ groups: requested }) => ({
      enabled: requested,
      note: `Call the group's tools directly from your next step. ${
        level === "core"
          ? "prepare_code_repository, propose_skill, request_login and request_form stay reachable through eve__tool."
          : "prepare_code_repository stays reachable through eve__tool."
      }`,
    }),
    inputSchema: z.object({ groups: z.array(z.enum(groups)).min(1) }),
    label: {
      start: ({ groups: requested }) => `Load ${requested.join(", ")} tools`,
    },
  });
  return { groups, tool };
}

export const { groups, tool } = enableTools(LAZY_LEVEL);

// Off: no tool at all. On: hidden once every group is already enabled.
export default defineDynamic((ctx) =>
  LAZY_TOOLS && enabledGroups(ctx.view).size < groups.length ? tool : null
);
