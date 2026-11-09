import type { ElementContent, Properties, Root, RootContent } from "hast";

// A text node that appears verbatim in the message source travels as its
// [start, end] offsets; the client already has that source as the message text.
type SourceSlice = [number, number];
type PackedNode =
  | string
  | SourceSlice
  | [string, PackedNode[]]
  | [string, Properties, PackedNode[]]
  | RootContent;

const QUOTES = /["']/gu;
// Shorter strings cost less than their offsets.
const MIN_SLICE_LENGTH = 8;

function packer(source: string) {
  let cursor = 0;
  const slice = (value: string): string | SourceSlice => {
    if (value.length < MIN_SLICE_LENGTH) {
      return value;
    }
    // Text nodes come in document order; fall back to any earlier match.
    let start = source.indexOf(value, cursor);
    if (start < 0) {
      start = source.indexOf(value);
    }
    if (start < 0) {
      return value;
    }
    cursor = start + value.length;
    return [start, cursor];
  };
  const pack = (node: RootContent): PackedNode => {
    if (node.type === "text" && Object.keys(node).length === 2) {
      return slice(node.value);
    }
    if (node.type === "element" && Object.keys(node).length === 4) {
      const children = node.children.map(pack);
      return Object.keys(node.properties).length
        ? [node.tagName, node.properties, children]
        : [node.tagName, children];
    }
    // Preserve uncommon node types and plugin metadata without interpreting them.
    return node;
  };
  return pack;
}

function unpacker(source: string) {
  const unpack = (node: PackedNode): RootContent => {
    if (typeof node === "string") {
      return { type: "text", value: node };
    }
    if (Array.isArray(node)) {
      if (typeof node[0] === "number") {
        const [start, end] = node as SourceSlice;
        return { type: "text", value: source.slice(start, end) };
      }
      const [tagName, properties, children] = (
        node.length === 2 ? [node[0], {}, node[1]] : node
      ) as [string, Properties, PackedNode[]];
      return {
        children: children.map(unpack) as ElementContent[],
        properties,
        tagName,
        type: "element",
      };
    }
    return node;
  };
  return unpack;
}

// The tree is a JSON string inside RSC/JSON payloads, so each `"` is escaped
// once there and again in the HTML's inline Flight script. Swapping `"` and `'`
// (an involution) makes structural quotes free; apostrophes pay instead.
const swapQuotes = (value: string) =>
  value.replace(QUOTES, (quote) => (quote === '"' ? "'" : '"'));

/**
 * A compact wire format for already-sanitized trees; never persisted in facts.
 * Decode with the same `source` the tree was parsed from.
 */
export function encodeMarkdown(tree: Root, source = ""): string {
  return swapQuotes(
    JSON.stringify({
      ...tree,
      children: tree.children.map(packer(source)),
      ...(source ? { sourceLength: source.length } : {}),
    })
  );
}

/** Undefined when `source` is not the text the tree was encoded against. */
export function decodeMarkdown(value: string, source = ""): Root | undefined {
  const unpack = unpacker(source);
  const parsed = JSON.parse(
    // Trees encoded before the quote swap start with `{"` or `["`.
    value[1] === '"' ? value : swapQuotes(value)
  ) as
    | PackedNode[]
    | (Omit<Root, "children"> & {
        children: PackedNode[];
        sourceLength?: number;
      });
  if (Array.isArray(parsed)) {
    return { children: parsed.map(unpack), type: "root" };
  }
  const { sourceLength, ...root } = parsed;
  if (sourceLength !== undefined && sourceLength !== source.length) {
    return;
  }
  return { ...root, children: root.children.map(unpack) };
}
