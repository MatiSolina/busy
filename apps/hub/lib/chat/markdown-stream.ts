import remend from "remend";
import { parseMarkdownIntoBlocks } from "streamdown";
import { parseMarkdown } from "./markdown";
import type { MarkdownResult } from "./markdown-protocol";

const FENCE = /^[ \t]{0,3}(?<fence>`{3,}|~{3,})/u;
const TABLE_SEPARATOR =
  /^\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?$/u;

function incompleteFence(text: string) {
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const match = FENCE.exec(line)?.groups?.fence;
    if (!match) {
      continue;
    }
    if (fence === undefined) {
      fence = match;
    } else if (
      match.charAt(0) === fence.charAt(0) &&
      match.length >= fence.length
    ) {
      fence = undefined;
    }
  }
  return fence !== undefined;
}

export function renderMarkdown(
  text: string,
  streaming: boolean
): MarkdownResult {
  const content = streaming ? remend(text) : text;
  const parts = streaming ? parseMarkdownIntoBlocks(content) : [content];
  const last = parts.at(-1) ?? "";
  let offset = 0;
  return {
    blocks: parts.map((part, index) => {
      const start = offset;
      // A completed prefix remains stable as the final block grows. Include a
      // separator so even empty blocks have distinct identities.
      offset += part.length + 1;
      return {
        incomplete:
          streaming && index === parts.length - 1 && incompleteFence(part),
        offset: start,
        tree: parseMarkdown(part),
      };
    }),
    hideCaret:
      streaming &&
      (incompleteFence(last) ||
        last
          .split("\n")
          .some(
            (line) =>
              line.trim().includes("|") && TABLE_SEPARATOR.test(line.trim())
          )),
  };
}
