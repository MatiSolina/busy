import { defineMemory, defineMemoryProvider } from "eve/memory";
import { isConsultation } from "../lib/caller";
import { hubFetch } from "../lib/hub";

const EVE_MEMORY_HEADER_RE = /^<!-- eve-memory-file-v1[^>]*-->\n?/u;

// In a consultation the bot answers with what it remembers but can't change its memory:
// a request from another bot (maybe prompt-injected) never rewrites it.
export default defineMemory({
  provider: defineMemoryProvider({
    recall: {
      async "turn.started"() {
        const res = await hubFetch("/api/bot/memory");
        const doc = res.ok ? ((await res.json()) as { content: string }) : null;
        // eve keeps its file header after the last fact is removed: the header alone is no memory.
        const content = doc?.content.replace(EVE_MEMORY_HEADER_RE, "").trim();
        return {
          messages: content
            ? [{ content: `<memory>\n${content}\n</memory>`, id: "memory" }]
            : [],
        };
      },
    },
  }),
  scope: (ctx) => (isConsultation(ctx.session.auth) ? "bot" : null),
});
