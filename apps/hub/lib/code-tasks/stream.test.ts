import type { FxStreamLine } from "libfx";
import { expect, test } from "vitest";
import { codeStreamLines } from "./stream";

async function project(lines: FxStreamLine[], chunkBytes = 13) {
  const encoded = new TextEncoder().encode(
    lines.map((line) => JSON.stringify(line)).join("\n")
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += chunkBytes) {
        controller.enqueue(encoded.slice(offset, offset + chunkBytes));
      }
      controller.close();
    },
  });
  const result: FxStreamLine[] = [];
  for await (const line of codeStreamLines(stream.getReader())) {
    result.push(line);
  }
  return result;
}

test("stores contiguous narration as one chunk with the last durable cursor", async () => {
  const result = await project(
    [
      { cursor: 1, delta: "Revisé ", messageId: "turn-1", type: "text_delta" },
      {
        cursor: 2,
        delta: "el código.",
        messageId: "turn-1",
        type: "text_delta",
      },
      {
        cursor: 3,
        id: "call",
        input: {},
        messageId: "turn-1",
        name: "read_file",
        type: "tool_start",
      },
      { cursor: 4, delta: "Listo.", messageId: "turn-1", type: "text_delta" },
    ],
    1
  );
  expect(result).toEqual([
    {
      cursor: 2,
      delta: "Revisé el código.",
      messageId: "turn-1",
      type: "text_delta",
    },
    {
      cursor: 3,
      id: "call",
      input: {},
      messageId: "turn-1",
      name: "read_file",
      type: "tool_start",
    },
    { cursor: 4, delta: "Listo.", messageId: "turn-1", type: "text_delta" },
  ]);
});

test("keeps narration batches bounded and separates different turns", async () => {
  const result = await project([
    {
      cursor: 1,
      delta: "a".repeat(10_000),
      messageId: "turn-1",
      type: "text_delta",
    },
    {
      cursor: 2,
      delta: "b".repeat(10_000),
      messageId: "turn-1",
      type: "text_delta",
    },
    { cursor: 3, delta: "c", messageId: "turn-2", type: "text_delta" },
  ]);
  expect(result).toHaveLength(3);
  expect(result.map((line) => line.cursor)).toEqual([1, 2, 3]);
  expect(
    result
      .flatMap((line) => (line.type === "text_delta" ? [line.delta] : []))
      .join("")
  ).toBe(`${"a".repeat(10_000)}${"b".repeat(10_000)}c`);
});
