import type {
  MarkdownRequest,
  MarkdownResponse,
  MarkdownResult,
} from "./markdown-protocol";

let worker: Worker | null = null;
let sequence = 0;
let failed = false;
const pending = new Map<
  number,
  { resolve: (value: MarkdownResult) => void; reject: (reason: Error) => void }
>();

function rejectPending() {
  for (const request of pending.values()) {
    request.reject(new Error("Markdown worker unavailable"));
  }
  pending.clear();
}

export function warmMarkdownWorker() {
  if (worker || failed || typeof Worker === "undefined") {
    return;
  }
  try {
    const instance = new Worker(
      new URL("./markdown.worker.ts", import.meta.url),
      {
        type: "module",
      }
    );
    worker = instance;
    instance.addEventListener(
      "message",
      (event: MessageEvent<MarkdownResponse>) => {
        if (worker !== instance) {
          return;
        }
        const request = pending.get(event.data.id);
        if (!request) {
          return;
        }
        pending.delete(event.data.id);
        if ("result" in event.data) {
          request.resolve(event.data.result);
        } else {
          request.reject(new Error(event.data.error));
        }
      }
    );
    const onFailure = (event: Event) => {
      event.preventDefault();
      if (worker !== instance) {
        return;
      }
      failed = true;
      instance.terminate();
      worker = null;
      rejectPending();
    };
    instance.addEventListener("error", onFailure);
    instance.addEventListener("messageerror", onFailure);
  } catch {
    failed = true;
    worker = null;
  }
}

export function requestMarkdown(text: string, streaming: boolean) {
  warmMarkdownWorker();
  if (!worker) {
    return Promise.reject(new Error("Markdown worker unavailable"));
  }
  sequence += 1;
  const id = sequence;
  const request: MarkdownRequest = { id, streaming, text };
  return new Promise<MarkdownResult>((resolve, reject) => {
    pending.set(id, { reject, resolve });
    try {
      worker?.postMessage(request);
    } catch {
      pending.delete(id);
      reject(new Error("Markdown worker unavailable"));
    }
  });
}

export function closeMarkdownWorker() {
  worker?.terminate();
  worker = null;
  failed = false;
  rejectPending();
}

// Start loading while the rest of the interface is still hydrating. The parser
// runs in its own thread and is ready for a reply arriving just after startup.
// This dedicated worker belongs to the document, including retained chat routes.
// The browser disposes it with the document; hiding React Activity must not
// restart its module loading and bounded parse cache on every return visit.
warmMarkdownWorker();
