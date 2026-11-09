import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import {
  parseQuickReplies,
  QUICK_REPLIES_MAX,
  QUICK_REPLY_MAX_LENGTH,
} from "../lib/quick-replies";

// The chips belong to the user's chat: another bot or a child task has nobody to tap them.
export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) || ctx.session.parent ? null : tool
);

const tool = defineTool({
  availableInSubagents: false,
  description: `Offer the user 1 to ${QUICK_REPLIES_MAX} one-tap replies under your message, each under ${QUICK_REPLY_MAX_LENGTH} characters, written as the user would say them ("Send it", "Make it shorter"). Call it last, after your reply text, only when there are obvious next steps or a choice to make. The replies disappear as soon as the user writes anything.`,
  execute(input) {
    const parsed = parseQuickReplies(input);
    return parsed.ok
      ? { shown: parsed.replies }
      : {
          error: `Not shown: ${parsed.reason} Fix it and call again, or skip the replies.`,
        };
  },
  inputSchema: z.object({
    replies: z
      .array(z.string())
      .describe(
        `1 to ${QUICK_REPLIES_MAX} replies, each under ${QUICK_REPLY_MAX_LENGTH} characters.`
      ),
  }),
  label: { start: () => "Suggest replies" },
});
