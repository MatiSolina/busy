import type { MarkdownRequest, MarkdownResponse } from "./markdown-protocol";
import { renderMarkdown } from "./markdown-stream";

globalThis.addEventListener(
  "message",
  (event: MessageEvent<MarkdownRequest>) => {
    const { id, text, streaming } = event.data;
    let response: MarkdownResponse;
    try {
      response = { id, result: renderMarkdown(text, streaming) };
    } catch {
      response = { error: "Markdown parsing failed", id };
    }
    globalThis.postMessage(response);
  }
);
