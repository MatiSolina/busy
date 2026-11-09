import { generateText } from "ai";
import { defineDynamic, defineTool } from "eve/tools";
import { webFetch } from "eve/tools/web_fetch";
import { z } from "zod";
import config from "../config.json" with { type: "json" };
import { isConsultation } from "../lib/caller";
import { lazyResult } from "../lib/lazy-tools";
import { subscriptionModel } from "../lib/subscription-model";

const { billing, model } = config as typeof config & { billing?: string };

// With `prompt`, a model reads the page and only its answer enters the context, as Claude Code's
// WebFetch and OpenBot's web_search do. A raw page is up to 50 KB (~12k tokens); research with
// many fetches compacted every few steps (docs/lazy-tools.md#compaction).
const EXTRACT =
  "Answer the request using only the page below. Keep exact figures, names, dates and quotes, and list the URLs of relevant links. If the page does not contain the answer, say so in one sentence. Be concise.";

function extractor(sessionId: string) {
  return billing === "chatgpt" || billing === "grok"
    ? {
        model: subscriptionModel(billing, model, sessionId),
        // Same as agent.ts: subscription responses are not stored upstream.
        providerOptions: {
          openai: { include: ["reasoning.encrypted_content"], store: false },
        },
      }
    : { model };
}

export const CONSULTATION_WEB_FETCH_DENIED =
  "web_fetch is unavailable during a read-only consultation: it would send data outside Busy.";

// eve's built-in fetches from the app runtime, so the sandbox's deny-all never applies to it.
// A consultation must not reach third parties (H-07): the tool is hidden there, and execution checks
// again because a call offered earlier (or replayed through eve__tool) can still run.
export const guardedWebFetch = defineTool({
  description: `${webFetch.description}
- Pass \`prompt\` (what you need from the page) to get only the answer instead of the whole page. Prefer it for research: it keeps your context small. Omit it only when you need the full text.`,
  async execute(input, ctx) {
    if (isConsultation(ctx.session.auth)) {
      // Rejected before eve's fetch runs, so no request leaves the runtime.
      throw new Error(CONSULTATION_WEB_FETCH_DENIED);
    }
    const { prompt, ...fetchInput } = input;
    const page = await webFetch.execute(fetchInput, ctx);
    const { content } = page as { content?: unknown };
    if (!prompt || typeof content !== "string") {
      return page;
    }
    const { text } = await generateText({
      ...extractor(ctx.session.id),
      abortSignal: ctx.abortSignal,
      prompt: `${EXTRACT}\n\nRequest: ${prompt}\n\nURL: ${fetchInput.url}\n\n<page>\n${content}\n</page>`,
    } as Parameters<typeof generateText>[0]);
    return { answer: text, url: fetchInput.url };
  },
  inputSchema: z.object({
    format: z
      .enum(["markdown", "text", "html"])
      .optional()
      .describe('Format of the returned page. Defaults to "markdown".'),
    prompt: z
      .string()
      .optional()
      .describe(
        "What you need from the page. When set, returns only the answer, not the page."
      ),
    timeout: z
      .number()
      .positive()
      .max(120)
      .optional()
      .describe("Timeout in seconds. Defaults to 30, max 120."),
    url: z
      .string()
      .describe("The fully-formed URL to fetch. Must start with https://."),
  }),
  label: webFetch.label,
});

// eve's built-in, deferred only with `"lazyTools": "core"` (docs/lazy-tools.md).
export default defineDynamic((ctx) =>
  isConsultation(ctx.session.auth)
    ? null
    : lazyResult("web", ctx.view, guardedWebFetch)
);
