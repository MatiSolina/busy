import { MCP_APP_RESULT_KEY } from "../mcp/tool-ui";
import type { ClientRow } from "./items";
import { parseMarkdown } from "./markdown";
import { encodeMarkdown } from "./markdown-transport";

// Tool payloads below this size travel unchanged; larger ones keep only the
// fields the chat projection (items.ts, status.ts) reads. Full facts stay in
// the database and the trace routes.
const COMPACT_ABOVE = 1024;
// detailOf, taskIdFromInput and parseQuickReplies.
const INPUT_KEYS = [
  "command",
  "filePath",
  "pattern",
  "query",
  "replies",
  "taskId",
  "url",
];
// File cards, code-task references, plans, MCP app markers and error text.
const OUTPUT_KEYS = [
  MCP_APP_RESULT_KEY,
  "contentType",
  "error",
  "fileId",
  "name",
  "plan",
  "size",
  "taskId",
];
// mcpAppSnapshotId only accepts short text markers.
const MCP_MARKER_LENGTH = 256;

/**
 * Approximate JSON size, walking only until `limit` is passed: a small tool
 * body costs a few steps and a huge one stops after ~1 KB, never serializing.
 */
function sizeUpTo(value: unknown, limit: number): number {
  if (typeof value === "string") {
    return value.length + 2;
  }
  if (!value || typeof value !== "object") {
    return 8;
  }
  let total = 2;
  for (const [key, item] of Object.entries(value)) {
    total += key.length + 4 + sizeUpTo(item, limit - total);
    if (total > limit) {
      break;
    }
  }
  return total;
}

const large = (value: unknown) =>
  value !== undefined && sizeUpTo(value, COMPACT_ABOVE) > COMPACT_ABOVE;

function pick(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object") {
    return;
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    keys.filter((key) => key in source).map((key) => [key, source[key]])
  );
}

function compactOutput(output: unknown) {
  if (Array.isArray(output)) {
    return output.filter((block) => {
      const { text, type } = (block ?? {}) as {
        text?: unknown;
        type?: unknown;
      };
      return (
        type === "text" &&
        typeof text === "string" &&
        text.length <= MCP_MARKER_LENGTH
      );
    });
  }
  return pick(output, OUTPUT_KEYS);
}

/** Drop large tool bodies and hidden content the chat never renders. */
export function compactRow(row: ClientRow): ClientRow {
  const d = row.data.data;
  let data: Record<string, unknown> | undefined;
  if (row.type === "call.requested" && large(d.input)) {
    data = { ...d, input: pick(d.input, INPUT_KEYS) };
  } else if (row.type === "call.settled" && large(d.output)) {
    data = { ...d, output: compactOutput(d.output) };
  } else if (
    row.type === "content.completed" &&
    !(d.kind === "text" && ["reply", "narration"].includes(String(d.phase))) &&
    large(d.value)
  ) {
    data = Object.fromEntries(
      Object.entries(d).filter(([key]) => key !== "value")
    );
  }
  return data ? { ...row, data: { ...row.data, data } } : row;
}

/** Persisted facts stay unchanged. Prepared UI metadata is a transport concern. */
export function prepareMarkdownRows(rows: ClientRow[]): ClientRow[] {
  return rows.map((original) => {
    const row = compactRow(original);
    const { data } = row.data;
    if (
      row.type !== "content.completed" ||
      data.kind !== "text" ||
      !["reply", "narration"].includes(String(data.phase))
    ) {
      return row;
    }
    const text = String(data.value ?? "");
    // Avoid decoding every offscreen tree as a deep React Flight object graph.
    // Only the messages that mount need to deserialize their prepared tree.
    return {
      ...row,
      md: encodeMarkdown(parseMarkdown(text), text),
    };
  });
}
