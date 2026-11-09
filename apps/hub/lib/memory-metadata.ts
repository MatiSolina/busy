import { createHash } from "node:crypto";
import { type SQL, sql } from "drizzle-orm";
import {
  type MemoryDocumentEntry,
  parseMemoryDocument,
} from "@/lib/memory-doc";

export type MemoryOrigin = "bot" | "legacy" | "owner";
export type MemorySourceStatus =
  | "bot_identity_only"
  | "legacy"
  | "trusted_eve_turn"
  | "trusted_user"
  | "unavailable";
export type MemoryChange = "added" | "attributed" | "removed" | "updated";

export interface MemorySource {
  author: string | null;
  messageId?: string | null;
  origin: MemoryOrigin;
  sessionId?: string | null;
  sourceStatus: MemorySourceStatus;
  turnId?: string | null;
}

export interface MemoryMetadata {
  author: string | null;
  botSlug: string;
  createdAt: string | null;
  entryId: string;
  messageId: string | null;
  origin: MemoryOrigin;
  sessionId: string | null;
  sourceStatus: MemorySourceStatus;
  text: string;
  turnId: string | null;
  updatedAt: string | null;
}

export interface MemoryMetadataEvent {
  action: MemoryChange;
  afterText: string | null;
  author: string | null;
  beforeText: string | null;
  botSlug: string;
  createdAt: string;
  documentVersion: number;
  entryId: string;
  messageId: string | null;
  origin: MemoryOrigin;
  sessionId: string | null;
  sourceStatus: MemorySourceStatus;
  turnId: string | null;
}

interface Executor {
  execute: (query: SQL) => Promise<unknown>;
}

interface MetadataRow {
  author: string | null;
  bot_slug: string;
  created_at: Date | string;
  entry_id: string;
  message_id: string | null;
  origin: MemoryOrigin;
  session_id: string | null;
  source_status: MemorySourceStatus;
  text: string;
  turn_id: string | null;
  updated_at: Date | string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toMetadata = (row: MetadataRow): MemoryMetadata => ({
  author: row.author,
  botSlug: row.bot_slug,
  createdAt: row.origin === "legacy" ? null : iso(row.created_at),
  entryId: row.entry_id,
  messageId: row.message_id,
  origin: row.origin,
  sessionId: row.session_id,
  sourceStatus: row.source_status,
  text: row.text,
  turnId: row.turn_id,
  updatedAt: row.origin === "legacy" ? null : iso(row.updated_at),
});

const sourceToRow = (source: MemorySource) => ({
  author: source.author,
  messageId: source.messageId ?? null,
  origin: source.origin,
  sessionId: source.sessionId ?? null,
  sourceStatus: source.sourceStatus,
  turnId: source.turnId ?? null,
});

async function queryRows<T extends readonly unknown[]>(
  executor: Executor,
  query: SQL
): Promise<T> {
  const result = await executor.execute(query);
  if (Array.isArray(result)) {
    return result as unknown as T;
  }
  if (
    typeof result === "object" &&
    result !== null &&
    "rows" in result &&
    Array.isArray(result.rows)
  ) {
    return result.rows as unknown as T;
  }
  return [] as unknown as T;
}

function eventKey(
  entryId: string,
  action: MemoryChange,
  beforeText: string | null,
  afterText: string | null,
  documentVersion: number
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action,
        afterText,
        beforeText,
        documentVersion,
        entryId,
      })
    )
    .digest("hex");
}

async function insertEvent(
  executor: Executor,
  botSlug: string,
  entryId: string,
  documentVersion: number,
  action: MemoryChange,
  beforeText: string | null,
  afterText: string | null,
  origin: MemoryOrigin,
  sourceStatus: MemorySourceStatus,
  source: Pick<MemorySource, "author" | "messageId" | "sessionId" | "turnId">
) {
  await executor.execute(sql`
    INSERT INTO public.memory_metadata_events (
      bot_slug, entry_id, document_version, action, before_text, after_text,
      origin, source_status, author, message_id, session_id, turn_id, change_key
    ) VALUES (
      ${botSlug}, ${entryId}, ${documentVersion}, ${action}, ${beforeText}, ${afterText},
      ${origin}, ${sourceStatus}, ${source.author}, ${source.messageId ?? null},
      ${source.sessionId ?? null}, ${source.turnId ?? null},
      ${eventKey(entryId, action, beforeText, afterText, documentVersion)}
    ) ON CONFLICT (bot_slug, change_key) DO NOTHING
  `);
}

async function upsertMetadata(
  executor: Executor,
  botSlug: string,
  entry: MemoryDocumentEntry,
  version: number,
  source: MemorySource,
  existing: MemoryMetadata | undefined,
  recordEvent = true,
  canAttribute = false
) {
  const row = sourceToRow(source);
  const changed = !existing || existing.text !== entry.text;
  const attributed =
    existing &&
    existing.text === entry.text &&
    source.sourceStatus === "trusted_eve_turn" &&
    canAttribute;
  // A provenance reconciliation must not rewrite the author/date of every
  // unchanged fact in the document. Only a text change or an explicit,
  // verified Eve-turn attribution can update an existing row.
  if (existing && !changed && !attributed) {
    return;
  }
  await executor.execute(sql`
    INSERT INTO public.memory_metadata (
      bot_slug, entry_id, text, origin, source_status, author, message_id,
      session_id, turn_id, created_at, updated_at
    ) VALUES (
      ${botSlug}, ${entry.id}, ${entry.text}, ${row.origin}, ${row.sourceStatus},
      ${row.author}, ${row.messageId}, ${row.sessionId}, ${row.turnId}, now(), now()
    ) ON CONFLICT (bot_slug, entry_id) DO UPDATE SET
      text = excluded.text,
      origin = excluded.origin,
      source_status = excluded.source_status,
      author = excluded.author,
      message_id = excluded.message_id,
      session_id = excluded.session_id,
      turn_id = excluded.turn_id,
      updated_at = now()
  `);

  if (recordEvent && (changed || attributed)) {
    let action: MemoryChange = "added";
    if (attributed) {
      action = "attributed";
    } else if (existing) {
      action = "updated";
    }
    await insertEvent(
      executor,
      botSlug,
      entry.id,
      version,
      action,
      existing?.text ?? null,
      entry.text,
      source.origin,
      source.sourceStatus,
      row
    );
  }
}

/** Read current metadata without reading the eve document itself. */
export async function listMemoryMetadata(
  executor: Executor,
  botSlug: string
): Promise<MemoryMetadata[]> {
  const rows = await queryRows<MetadataRow[]>(
    executor,
    sql`
    SELECT author, bot_slug, created_at, entry_id, message_id, origin,
      session_id, source_status, text, turn_id, updated_at
    FROM public.memory_metadata
    WHERE bot_slug = ${botSlug}
    ORDER BY updated_at DESC, entry_id::bigint DESC
  `
  );
  return rows.map(toMetadata);
}

/** Read the immutable provenance trail for audits and history search. */
export async function listMemoryMetadataEvents(
  executor: Executor,
  botSlug: string,
  entryId?: string
): Promise<MemoryMetadataEvent[]> {
  const rows = await queryRows<
    (Omit<MetadataRow, "created_at" | "updated_at"> & {
      action: MemoryChange;
      after_text: string | null;
      before_text: string | null;
      created_at: Date | string;
      document_version: number;
    })[]
  >(
    executor,
    sql`
    SELECT action, after_text, author, before_text, bot_slug, created_at,
      document_version, entry_id, message_id, origin, session_id,
      source_status, turn_id
    FROM public.memory_metadata_events
    WHERE bot_slug = ${botSlug}
      AND (${entryId ?? null}::text IS NULL OR entry_id = ${entryId ?? null})
    ORDER BY created_at ASC, id ASC
  `
  );
  return rows.map((row) => ({
    action: row.action,
    afterText: row.after_text,
    author: row.author,
    beforeText: row.before_text,
    botSlug: row.bot_slug,
    createdAt: iso(row.created_at),
    documentVersion: row.document_version,
    entryId: row.entry_id,
    messageId: row.message_id,
    origin: row.origin,
    sessionId: row.session_id,
    sourceStatus: row.source_status,
    turnId: row.turn_id,
  }));
}

/**
 * Reconcile the current eve document with metadata in the same transaction as
 * the document version change. Existing entries with no metadata stay honest:
 * they are labelled legacy rather than receiving invented dates or authors.
 */
export async function syncMemoryMetadata(
  executor: Executor,
  input: {
    botSlug: string;
    content: string;
    documentVersion: number;
    previousContent: string | null;
    source: MemorySource;
  }
): Promise<void> {
  const current = parseMemoryDocument(input.content);
  if (!current) {
    throw new Error("Memory document has an invalid eve file format.");
  }
  const previous = input.previousContent
    ? parseMemoryDocument(input.previousContent)
    : null;
  const previousById = new Map(
    (previous?.entries ?? []).map((entry) => [entry.id, entry])
  );
  const metadata = await listMemoryMetadata(executor, input.botSlug);
  const metadataById = new Map(metadata.map((row) => [row.entryId, row]));
  const currentIds = new Set(current.entries.map((entry) => entry.id));
  const pendingBotChanges = new Set(
    (
      await queryRows<{ entry_id: string }[]>(
        executor,
        sql`
        SELECT bot_change.entry_id
        FROM public.memory_metadata_events bot_change
        WHERE bot_change.bot_slug = ${input.botSlug}
          AND bot_change.document_version = ${input.documentVersion}
          AND bot_change.source_status = 'bot_identity_only'
          AND bot_change.action IN ('added', 'updated')
          -- A verified turn consumes the bot-only provenance for this
          -- document version. Do not attribute it again when the same
          -- unchanged document is posted by a later turn.
          AND NOT EXISTS (
            SELECT 1
            FROM public.memory_metadata_events resolved
            WHERE resolved.bot_slug = ${input.botSlug}
              AND resolved.entry_id = bot_change.entry_id
              AND resolved.document_version = ${input.documentVersion}
              AND resolved.action = 'attributed'
          )
      `
      )
    ).map((row) => row.entry_id)
  );

  for (const entry of current.entries) {
    const existing = metadataById.get(entry.id);
    const previousEntry = previousById.get(entry.id);
    if (!existing && previousEntry && previousEntry.text === entry.text) {
      // Metadata rows are reconciled in order inside the same transaction so
      // a document write and its provenance cannot be observed halfway.
      // biome-ignore lint/performance/noAwaitInLoops: Metadata writes share one transaction and must preserve document order.
      await upsertMetadata(
        executor,
        input.botSlug,
        entry,
        input.documentVersion,
        { author: null, origin: "legacy", sourceStatus: "legacy" },
        undefined,
        false
      );
      continue;
    }
    await upsertMetadata(
      executor,
      input.botSlug,
      entry,
      input.documentVersion,
      input.source,
      existing,
      true,
      pendingBotChanges.has(entry.id)
    );
  }

  for (const existing of metadata) {
    if (currentIds.has(existing.entryId)) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Delete audit and row removal are intentionally atomic and ordered.
    await insertEvent(
      executor,
      input.botSlug,
      existing.entryId,
      input.documentVersion,
      "removed",
      existing.text,
      null,
      input.source.origin,
      input.source.sourceStatus,
      sourceToRow(input.source)
    );
    await executor.execute(sql`
      DELETE FROM public.memory_metadata
      WHERE bot_slug = ${input.botSlug} AND entry_id = ${existing.entryId}
    `);
  }
}

/** Metadata synthesized for entries created before migration 0017. */
export const legacyMetadata = (
  botSlug: string,
  entry: MemoryDocumentEntry
): MemoryMetadata => ({
  author: null,
  botSlug,
  createdAt: null,
  entryId: entry.id,
  messageId: null,
  origin: "legacy",
  sessionId: null,
  sourceStatus: "legacy",
  text: entry.text,
  turnId: null,
  updatedAt: null,
});
