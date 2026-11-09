import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { searchHistory } from "../lib/history";
import { lazyResult } from "../lib/lazy-tools";

const tool = defineTool({
  availableInSubagents: false,
  description:
    "Search this bot's earlier conversation with the user by words. It searches user messages and the bot's completed replies, excludes bot-to-bot consultations, and returns stable message references. Use read_history with one result id to inspect nearby context.",
  execute({ limit, query }, ctx) {
    if (isConsultation(ctx.session.auth) || ctx.session.parent) {
      return {
        error: "History search is available only in the bot's primary chat.",
      };
    }
    return searchHistory(query, limit, undefined, ctx.abortSignal);
  },
  inputSchema: z.object({
    limit: z.number().int().min(1).max(8).default(8),
    query: z.string().trim().min(1).max(200),
  }),
  label: { start: ({ query }) => `Search history for ${query}` },
});

export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) || ctx.session.parent
    ? null
    : lazyResult("history", ctx.view, tool)
);
