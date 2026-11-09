// eve fileMemory's document: a version header, then one `<index>: <text>` line per entry.
// Keep these helpers aligned with eve's fileMemory format. The hub owns the
// document's bytes and version; it does not maintain a second memory store.
const HEADER =
  /^<!-- eve-memory-file-v1 lastAllocatedIndex=(?<lastAllocatedIndex>-1|0|[1-9]\d*) -->\n/u;
const ENTRY = /^(?<id>\d+): (?<text>.+)$/u;
const MAX_ENTRY_BYTES = 2048;

export interface MemoryDocumentEntry {
  id: string;
  text: string;
}

export interface MemoryDocument {
  entries: MemoryDocumentEntry[];
  lastAllocatedIndex: number;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** Matches eve's whitespace normalization and per-entry limit. */
export function normalizeMemoryText(text: string): string {
  const normalized = text.trim().replaceAll(/\s+/gu, " ");
  if (!normalized) {
    throw new Error("Memory text cannot be empty.");
  }
  if (utf8Bytes(normalized) > MAX_ENTRY_BYTES) {
    throw new Error("Memory text exceeds 2,048 UTF-8 bytes.");
  }
  return normalized;
}

/** Parse the exact versioned document that eve's fileMemory reads and writes. */
export function parseMemoryDocument(content: string): MemoryDocument | null {
  const header = HEADER.exec(content);
  if (!header) {
    return null;
  }
  const lastAllocatedIndex = Number(header.groups?.lastAllocatedIndex);
  const body = content.slice(header[0].length);
  if (body && !body.endsWith("\n")) {
    return null;
  }
  const lines = body ? body.slice(0, -1).split("\n") : [];
  const ids = new Set<number>();
  const entries: MemoryDocumentEntry[] = [];
  for (const line of lines) {
    const match = ENTRY.exec(line);
    const id = match?.groups?.id;
    const text = match?.groups?.text;
    const numericId = id === undefined ? Number.NaN : Number(id);
    if (
      id === undefined ||
      text === undefined ||
      !Number.isSafeInteger(numericId) ||
      numericId > lastAllocatedIndex ||
      ids.has(numericId) ||
      normalizeMemoryText(text) !== text
    ) {
      return null;
    }
    ids.add(numericId);
    entries.push({ id, text });
  }
  if (lastAllocatedIndex === -1 && entries.length > 0) {
    return null;
  }
  return { entries, lastAllocatedIndex };
}

export function formatMemoryDocument(document: MemoryDocument): string {
  const header = `<!-- eve-memory-file-v1 lastAllocatedIndex=${document.lastAllocatedIndex} -->\n`;
  if (!document.entries.length) {
    return header;
  }
  return `${header}${[...document.entries]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((entry) => `${entry.id}: ${entry.text}`)
    .join("\n")}\n`;
}

export function appendMemoryEntry(
  content: string,
  text: string
): { content: string; entry: MemoryDocumentEntry | null } {
  const parsed = content
    ? parseMemoryDocument(content)
    : { entries: [], lastAllocatedIndex: -1 };
  if (!parsed) {
    throw new Error("Memory document has an invalid eve file format.");
  }
  const normalized = normalizeMemoryText(text);
  const duplicate = parsed.entries.find(
    (candidate) => candidate.text === normalized
  );
  if (duplicate) {
    return { content, entry: null };
  }
  if (parsed.lastAllocatedIndex >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Memory has no available index.");
  }
  const entry = {
    id: String(parsed.lastAllocatedIndex + 1),
    text: normalized,
  };
  return {
    content: formatMemoryDocument({
      entries: [...parsed.entries, entry],
      lastAllocatedIndex: Number(entry.id),
    }),
    entry,
  };
}

export function replaceMemoryEntry(
  content: string,
  id: string,
  text: string
): string {
  const parsed = parseMemoryDocument(content);
  if (!parsed) {
    throw new Error("Memory document has an invalid eve file format.");
  }
  const normalized = normalizeMemoryText(text);
  let found = false;
  const entries = parsed.entries.map((entry) => {
    if (entry.id !== id) {
      return entry;
    }
    found = true;
    return { id, text: normalized };
  });
  if (!found) {
    throw new Error("Memory entry not found.");
  }
  return formatMemoryDocument({
    entries,
    lastAllocatedIndex: parsed.lastAllocatedIndex,
  });
}

export function removeMemoryEntry(content: string, id: string): string {
  const parsed = parseMemoryDocument(content);
  if (!parsed) {
    throw new Error("Memory document has an invalid eve file format.");
  }
  const entries = parsed.entries.filter((entry) => entry.id !== id);
  if (entries.length === parsed.entries.length) {
    throw new Error("Memory entry not found.");
  }
  return formatMemoryDocument({
    entries,
    lastAllocatedIndex: parsed.lastAllocatedIndex,
  });
}

export function parseMemoryDoc(content: string): MemoryDocumentEntry[] {
  return content.split("\n").flatMap((line) => {
    const m = ENTRY.exec(line);
    const id = m?.groups?.id;
    const text = m?.groups?.text;
    return id !== undefined && text !== undefined ? [{ id, text }] : [];
  });
}

export function removeEntry(content: string, id: string): string {
  return content
    .split("\n")
    .filter((line) => ENTRY.exec(line)?.groups?.id !== id)
    .join("\n");
}
