import {
  type MemoryDocumentBackend,
  MemoryDocumentConflictError,
} from "eve/memory/file";
import { type HubFetch, hubFetch } from "./hub";

interface Stored {
  content: string;
  version: number;
}

// eve runs each memory's turn.started recall one after another. The first recall of a main-chat
// turn starts the memory read here so it overlaps the directory read instead of following it.
const PREFETCH_MS = 10_000;
let prefetched: { at: number; res: Promise<Response> } | undefined;

/** Starts this turn's main memory read early. Used once, by the next read within 10 s. */
export function prefetchMemory(fetchHub: HubFetch = hubFetch): void {
  const res = fetchHub("/api/bot/memory");
  res.catch(() => undefined);
  prefetched = { at: Date.now(), res };
}

function takePrefetched(): Promise<Response> | undefined {
  const taken = prefetched;
  prefetched = undefined;
  return taken && Date.now() - taken.at < PREFETCH_MS ? taken.res : undefined;
}

// fileMemory keeps its tools and limits; the document lives in the hub (spec 4.5).
export function hubMemoryBackend(
  fetchHub: HubFetch = hubFetch
): MemoryDocumentBackend {
  const toDoc = (s: Stored) => ({
    content: s.content,
    version: String(s.version),
  });
  return {
    async read({ signal }) {
      signal.throwIfAborted();
      // Only the main chat's backend prefetches; a fireside's own backend never takes it.
      const early = fetchHub === hubFetch ? takePrefetched() : undefined;
      const res = await (early?.catch(() =>
        fetchHub("/api/bot/memory", { signal })
      ) ?? fetchHub("/api/bot/memory", { signal }));
      if (res.status === 404) {
        return null;
      }
      if (!res.ok) {
        throw new Error(`hub memory read failed: ${res.status}`);
      }
      return toDoc((await res.json()) as Stored);
    },
    async write({ key, content, expectedVersion, signal }) {
      signal.throwIfAborted();
      // A read after this write must see it, never a prefetch from before.
      prefetched = undefined;
      const res = await fetchHub("/api/bot/memory", {
        body: JSON.stringify({
          content,
          expectedVersion:
            expectedVersion === null ? null : Number(expectedVersion),
        }),
        method: "PUT",
        signal,
      });
      if (res.status === 409) {
        throw new MemoryDocumentConflictError(key);
      }
      if (!res.ok) {
        throw new Error(`hub memory write failed: ${res.status}`);
      }
      return toDoc((await res.json()) as Stored);
    },
  };
}
