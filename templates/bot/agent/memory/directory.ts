import { defineMemory, defineMemoryProvider } from "eve/memory";
import { isConsultation } from "../lib/caller";
import { firesideIdentity } from "../lib/fireside";
import { prefetchMemory } from "../lib/hub-memory";
import { fetchDirectory, formatDirectory } from "../lib/peers";

// Read-only: the hub owns the directory; the bot never writes it (spec 4.6).
export default defineMemory({
  provider: defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const directory = fetchDirectory();
        // eve runs the main memory's recall (memory.ts) after this one: start its read now.
        if (!firesideIdentity(ctx)) {
          prefetchMemory();
        }
        return {
          messages: [
            { content: formatDirectory(await directory), id: "directory" },
          ],
        };
      },
    },
  }),
  // A consulted bot sees no peers: one hop.
  scope: (ctx) => (isConsultation(ctx.session.auth) ? null : "bot"),
});
