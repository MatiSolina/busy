import type { FxStreamLine } from "libfx";

type TextLine = Extract<FxStreamLine, { type: "text_delta" }>;

function combineText(left: TextLine | null, right: TextLine): TextLine {
  return { ...right, delta: (left?.delta ?? "") + right.delta };
}

/** Coalesce contiguous narration before storing it, retaining the last covered cursor. */
async function* coalesceNarration(
  lines: AsyncIterable<FxStreamLine>
): AsyncGenerator<FxStreamLine> {
  let pending: TextLine | null = null;
  for await (const line of lines) {
    if (line.type === "text_delta") {
      if (
        pending &&
        (pending.messageId !== line.messageId ||
          pending.delta.length + line.delta.length > 16_000)
      ) {
        yield pending;
        pending = null;
      }
      pending = combineText(pending, line);
    } else {
      if (pending) {
        yield pending;
        pending = null;
      }
      yield line;
    }
  }
  if (pending) {
    yield pending;
  }
}

async function* readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<FxStreamLine> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: durable stream bytes must be decoded in order.
    const result = await reader.read();
    if (result.done) {
      text += decoder.decode();
      break;
    }
    text += decoder.decode(result.value, { stream: true });
    let end = text.indexOf("\n");
    while (end >= 0) {
      const raw = text.slice(0, end);
      text = text.slice(end + 1);
      if (raw.trim()) {
        yield JSON.parse(raw) as FxStreamLine;
      }
      end = text.indexOf("\n");
    }
  }
  if (text.trim()) {
    yield JSON.parse(text) as FxStreamLine;
  }
}

export function codeStreamLines(
  reader: ReadableStreamDefaultReader<Uint8Array>
) {
  return coalesceNarration(readLines(reader));
}
