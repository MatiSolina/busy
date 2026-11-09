import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";

// Same set the hub accepts (apps/hub/lib/chat/reactions.ts): anything else is not shown.
export const REACTIONS = ["👍", "❤️", "😂", "🎉", "🙏", "👀", "✅"] as const;

// A reaction sits on the user's message in their chat: another bot or a child task has none.
export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) || ctx.session.parent ? null : tool
);

const tool = defineTool({
  availableInSubagents: false,
  description:
    "React with one emoji to the user's latest message. Use it instead of a reply when words would be overkill (a thanks, an ok, a done), or alongside a reply. A new reaction replaces the previous one.",
  execute: ({ emoji }) => ({ shown: emoji }),
  inputSchema: z.object({ emoji: z.enum(REACTIONS) }),
  label: { start: () => "React" },
});
