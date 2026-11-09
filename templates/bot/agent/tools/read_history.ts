import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { isConsultation } from "../lib/caller";
import { readHistory } from "../lib/history";
import { lazyResult } from "../lib/lazy-tools";

const tool = defineTool({
  availableInSubagents: false,
  description:
    "Read up to six messages before and after one result returned by search_history. Pass the result's exact id; the context is limited to this bot's primary chat and excludes consultations.",
  execute({ id, query }, ctx) {
    if (isConsultation(ctx.session.auth) || ctx.session.parent) {
      return {
        error: "History context is available only in the bot's primary chat.",
      };
    }
    return readHistory(query, id, undefined, ctx.abortSignal);
  },
  inputSchema: z.object({
    id: z.string().trim().min(1).max(240),
    query: z.string().trim().min(1).max(200),
  }),
  label: { start: () => "Read history context" },
});

export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth) || ctx.session.parent
    ? null
    : lazyResult("history", ctx.view, tool)
);
