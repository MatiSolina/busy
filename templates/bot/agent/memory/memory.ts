import { defineMemory, defineMemoryProvider } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { isConsultation } from "../lib/caller";
import { firesideHeaders, firesideIdentity } from "../lib/fireside";
import { hubFetch } from "../lib/hub";
import { hubMemoryBackend } from "../lib/hub-memory";
import { fetchDirectory } from "../lib/peers";

// One document per bot, written only from the user's chat (spec 4.5). A consultation recalls it read-only (recall.ts).
const fileProvider = fileMemory({ backend: hubMemoryBackend() });

function providerFor(ctx: Parameters<typeof firesideIdentity>[0]) {
  const identity = firesideIdentity(ctx);
  if (!identity) {
    return fileProvider;
  }
  // Eve hashes the scope key. Bind the backend from verified session context,
  // never infer authorization from that opaque key or from model arguments.
  return fileMemory({
    backend: hubMemoryBackend((_path, init) =>
      hubFetch("/api/bot/firesides/memory", {
        ...init,
        headers: { ...init?.headers, ...firesideHeaders(identity) },
      })
    ),
  });
}

const provenanceProvider = defineMemoryProvider({
  capture: {
    // fileMemory's backend intentionally stays the source of truth. This hook
    // only annotates the already-written document with Eve's verified session
    // and turn context; a PUT without that context remains bot-identity-only.
    async "turn.completed"(ctx) {
      if (firesideIdentity(ctx)) {
        return;
      }
      const document = await hubFetch("/api/bot/memory", {
        signal: ctx.abortSignal,
      });
      if (!document.ok) {
        return;
      }
      const current = (await document.json()) as {
        content: string;
        version: number;
      };
      await hubFetch("/api/bot/memory", {
        body: JSON.stringify({
          content: current.content,
          sessionId: ctx.session.id,
          turnId: ctx.turn.id,
          version: current.version,
        }),
        method: "POST",
        signal: ctx.abortSignal,
      });
    },
  },
  recall: {
    "turn.started": (ctx) => {
      // If eve runs this recall first, start the directory's (directory.ts): it reuses the promise.
      if (!(firesideIdentity(ctx) || isConsultation(ctx.session.auth))) {
        fetchDirectory().catch(() => undefined);
      }
      return providerFor(ctx).recall["turn.started"](ctx);
    },
  },
  tools: async (ctx) => (await providerFor(ctx).tools?.(ctx)) ?? null,
});

export default defineMemory({
  description:
    "Lasting facts and preferences this bot learns from its work and from the user.",
  provider: provenanceProvider,
  scope: (ctx) =>
    firesideIdentity(ctx)?.participantId ??
    (isConsultation(ctx.session.auth) ? null : "bot"),
});
