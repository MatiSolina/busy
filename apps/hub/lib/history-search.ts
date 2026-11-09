import { getVercelOidcToken } from "@vercel/oidc";
import { sql } from "drizzle-orm";
import { bots, consultations, db, events, messages } from "@/lib/db";

const MAX_QUERY_LENGTH = 200;
const MAX_RESULTS = 50;
const DEFAULT_RESULTS = 20;
const CONTEXT_ROWS = 6;

export type HistoryRole = "user" | "assistant";

export interface HistoryResult {
  createdAt: string;
  id: string;
  role: HistoryRole;
  score: number;
  semanticScore?: number;
  sessionId: string | null;
  source: "event" | "memory" | "message";
  text: string;
  turnId: string | null;
}

export interface HistoryAround extends HistoryResult {
  after: HistoryResult[];
  before: HistoryResult[];
}

export interface SemanticHistoryProvider {
  search: (
    query: string,
    candidates: readonly HistoryResult[]
  ) => Promise<SemanticHistoryResult>;
}

export interface SemanticHistoryResult {
  candidates: HistoryResult[];
  scores: ReadonlyMap<string, number>;
}

export interface HistorySearchOptions {
  limit?: number;
  semantic?: SemanticHistoryProvider;
}

type StoredResult = Omit<HistoryResult, "score" | "semanticScore"> & {
  score: number;
};

function resultRows<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (
    value &&
    typeof value === "object" &&
    "rows" in value &&
    Array.isArray((value as { rows?: unknown }).rows)
  ) {
    return (value as { rows: T[] }).rows;
  }
  return [];
}

function normalizedQuery(query: string): string {
  const value = query.trim();
  if (!value) {
    throw new Error("Search query is required");
  }
  if (value.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `Search query is limited to ${MAX_QUERY_LENGTH} characters`
    );
  }
  return value;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_RESULTS;
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Search limit must be a positive integer");
  }
  return Math.min(limit, MAX_RESULTS);
}

function resultOf(row: StoredResult): HistoryResult {
  return {
    createdAt: new Date(row.createdAt).toISOString(),
    id: row.id,
    role: row.role,
    score: Number(row.score),
    sessionId: row.sessionId,
    source: row.source,
    text: row.text,
    turnId: row.turnId,
  };
}

/**
 * Search the primary bot conversation. User messages come from `messages` and
 * assistant replies from persisted `content.completed` facts. Child consultation
 * sessions are excluded by their trusted `consultations.child_session_id` row;
 * no model supplied bot or session id participates in authorization.
 */
async function lexicalSearch(
  botId: string,
  query: string,
  limit: number
): Promise<HistoryResult[]> {
  const raw = await db().execute<StoredResult>(sql`
    with documents as (
      select
        m.id::text as id,
        m.created_at as created_at,
        'user'::text as role,
        m.text as text,
        null::text as session_id,
        null::text as turn_id,
        'message'::text as source
      from ${messages} m
      where m.bot_id = ${botId}::uuid
        and m.status = 'accepted'
        and length(btrim(m.text)) > 0

      union all

      select
        e.session_id || ':' || e.line::text || ':' || e.index::text as id,
        e.at as created_at,
        'assistant'::text as role,
        e.data->'data'->>'value' as text,
        e.session_id as session_id,
        coalesce(e.data->'scope'->>'turnId', e.data->'data'->>'turnId') as turn_id,
        'event'::text as source
      from ${events} e
      where e.bot_id = ${botId}::uuid
        and e.type = 'content.completed'
        and e.data->'data'->>'kind' = 'text'
        and e.data->'data'->>'phase' = 'reply'
        and length(btrim(coalesce(e.data->'data'->>'value', ''))) > 0
        and not exists (
          select 1
          from ${consultations} c
          where c.child_session_id = e.session_id
        )

      union all

      select
        b.slug || ':memory:' || mm.entry_id as id,
        mm.updated_at as created_at,
        'assistant'::text as role,
        mm.text as text,
        null::text as session_id,
        null::text as turn_id,
        'memory'::text as source
      from public.memory_metadata mm
      inner join ${bots} b on b.slug = mm.bot_slug
      where b.id = ${botId}::uuid
        and length(btrim(mm.text)) > 0
    ),
    ranked_documents as (
      select
        d.*,
        to_tsvector('simple', d.text) as document_vector
      from documents d
    )
    select
        d.id,
        d.created_at as "createdAt",
      d.role,
      d.text,
        d.session_id as "sessionId",
        d.turn_id as "turnId",
      d.source,
      ts_rank_cd(
        d.document_vector,
        plainto_tsquery('simple', ${query})
      )::double precision as score
    from ranked_documents d
    where d.document_vector @@ plainto_tsquery('simple', ${query})
    order by score desc, d.created_at desc, d.id desc
    limit ${limit}
  `);

  return resultRows<StoredResult>(raw).map(resultOf);
}

function fuse(
  lexical: readonly HistoryResult[],
  semantic: SemanticHistoryResult,
  limit: number
): HistoryResult[] {
  const byId = new Map(lexical.map((item) => [item.id, item]));
  for (const candidate of semantic.candidates) {
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }
  }
  const all = [...byId.values()];
  const maxSemantic = Math.max(...semantic.scores.values(), 0);
  for (const [id, semanticScore] of semantic.scores) {
    const item = byId.get(id);
    if (!item) {
      continue;
    }
    item.semanticScore = semanticScore;
  }

  // Reciprocal rank fusion keeps lexical search useful while an optional
  // semantic provider is warming or unavailable. Scores are deliberately
  // relative to this query; callers must not treat them as confidence.
  const ranked = all.map((item, index) => {
    const lexicalRank = 1 / (60 + index + 1);
    const semanticRank = semantic.scores.has(item.id)
      ? (1 + (semantic.scores.get(item.id) ?? 0) / Math.max(maxSemantic, 1)) /
        60
      : 0;
    return { item, score: lexicalRank + semanticRank };
  });
  return ranked
    .sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.item.createdAt).getTime() -
          new Date(a.item.createdAt).getTime()
    )
    .slice(0, limit)
    .map(({ item, score }) => ({ ...item, score }));
}

const embeddingTable = sql.raw("public.history_embeddings");
const embeddingModel = () =>
  process.env.HISTORY_EMBEDDINGS_ENABLED === "1"
    ? process.env.HISTORY_EMBEDDING_MODEL?.trim() || null
    : null;

interface EmbeddingRow extends Record<string, unknown> {
  botId?: string;
  contentHash: string;
  createdAt: Date | string;
  embedding: number[] | string | null;
  id: string;
  sessionId: string | null;
  source: "event" | "memory" | "message";
  text: string;
  turnId: string | null;
}

function parseVector(value: EmbeddingRow["embedding"]): number[] | null {
  if (Array.isArray(value)) {
    return value.every(
      (item) => typeof item === "number" && Number.isFinite(item)
    )
      ? value
      : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "number" && Number.isFinite(item))
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) {
    return -1;
  }
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return left && right ? dot / Math.sqrt(left * right) : -1;
}

async function gatewayEmbedding(
  input: string | readonly string[]
): Promise<number[][]> {
  const endpoint =
    process.env.HISTORY_EMBEDDING_URL?.trim() ||
    "https://ai-gateway.vercel.sh/v1/embeddings";
  const apiKey = process.env.HISTORY_EMBEDDING_API_KEY?.trim();
  const isGateway = endpoint === "https://ai-gateway.vercel.sh/v1/embeddings";
  const token =
    apiKey ||
    (isGateway ? process.env.AI_GATEWAY_API_KEY?.trim() : undefined) ||
    (isGateway ? await getVercelOidcToken() : null);
  if (!token) {
    throw new Error(
      "A custom embedding endpoint requires HISTORY_EMBEDDING_API_KEY."
    );
  }
  const response = await fetch(endpoint, {
    body: JSON.stringify({ input, model: embeddingModel() }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`embedding provider returned ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: { embedding?: unknown; index?: unknown }[];
  };
  const data = body.data ?? [];
  const count = typeof input === "string" ? 1 : input.length;
  if (data.length !== count) {
    throw new Error("embedding provider returned the wrong vector count");
  }
  const indexed = data.map((item, position) => ({
    embedding: item.embedding,
    index: item.index === undefined ? position : item.index,
  }));
  if (
    indexed.some(
      ({ index }) =>
        typeof index !== "number" ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= count
    ) ||
    new Set(indexed.map(({ index }) => index)).size !== count
  ) {
    throw new Error("embedding provider returned invalid vector indexes");
  }
  indexed.sort((a, b) => Number(a.index) - Number(b.index));
  const first = indexed[0]?.embedding;
  if (
    !Array.isArray(first) ||
    first.length === 0 ||
    first.some((value) => typeof value !== "number" || !Number.isFinite(value))
  ) {
    throw new Error("embedding provider returned an invalid vector");
  }
  return indexed.map(({ embedding }) => {
    if (
      !Array.isArray(embedding) ||
      embedding.length !== first.length ||
      embedding.some(
        (value) => typeof value !== "number" || !Number.isFinite(value)
      )
    ) {
      throw new Error(
        "embedding provider returned inconsistent vector dimensions"
      );
    }
    return embedding as number[];
  });
}

function configuredSemanticProvider(
  botId: string
): SemanticHistoryProvider | undefined {
  if (!embeddingModel()) {
    return undefined;
  }
  return {
    search: async (query) => {
      const [queryVector] = await gatewayEmbedding(query);
      if (!queryVector) {
        return { candidates: [], scores: new Map() };
      }
      const raw = await db().execute<EmbeddingRow>(sql`
        select source_id as id, source, text, created_at as "createdAt",
          session_id as "sessionId", turn_id as "turnId", embedding,
          content_hash as "contentHash"
        from ${embeddingTable}
        where bot_id = ${botId}::uuid
          and model = ${embeddingModel()} and embedding is not null
          and (
            (source = 'message' and exists (
              select 1 from ${messages} m
              where m.bot_id = ${botId}::uuid and m.id::text = source_id
                and m.status = 'accepted' and md5(m.text) = content_hash
            ))
            or (source = 'event' and exists (
              select 1 from ${events} e
              where e.bot_id = ${botId}::uuid
                and e.session_id = ${embeddingTable}.session_id
                and e.session_id || ':' || e.line::text || ':' || e.index::text = source_id
                and md5(e.data->'data'->>'value') = content_hash
                and not exists (
                  select 1 from ${consultations} c where c.child_session_id = e.session_id
                )
            ))
            or (source = 'memory' and exists (
              select 1 from public.memory_metadata mm
              inner join ${bots} b on b.slug = mm.bot_slug
              where b.id = ${botId}::uuid
                and b.slug || ':memory:' || mm.entry_id = source_id
                and md5(mm.text) = content_hash
            ))
          )
        order by updated_at desc
        limit 1000
      `);
      const rows = resultRows<EmbeddingRow>(raw);
      const scored = rows
        .flatMap((row) => {
          const vector = parseVector(row.embedding);
          if (!vector) {
            return [];
          }
          return [{ row, score: cosine(queryVector, vector) }];
        })
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 40);
      return {
        candidates: scored.map(({ row, score }) => ({
          createdAt: new Date(row.createdAt).toISOString(),
          id: row.id,
          role: row.source === "message" ? "user" : "assistant",
          score: 0,
          semanticScore: score,
          sessionId: row.sessionId,
          source: row.source,
          text: row.text,
          turnId: row.turnId,
        })),
        scores: new Map(scored.map(({ row, score }) => [row.id, score])),
      };
    },
  };
}

export async function searchHistory(
  botId: string,
  query: string,
  options: HistorySearchOptions = {}
): Promise<HistoryResult[]> {
  const normalized = normalizedQuery(query);
  const limit = boundedLimit(options.limit);
  const lexical = await lexicalSearch(botId, normalized, Math.max(limit, 40));
  const semanticProvider =
    options.semantic ?? configuredSemanticProvider(botId);
  if (!semanticProvider) {
    return lexical.slice(0, limit);
  }
  try {
    const semantic = await semanticProvider.search(normalized, lexical);
    return fuse(lexical, semantic, limit);
  } catch {
    // Search remains available when an embedding service times out, is disabled,
    // or rejects a model. The caller can expose that only as a non-sensitive hint.
    return lexical.slice(0, limit);
  }
}

/** Return a bounded window around a result without exposing consultation rows. */
export async function aroundHistory(
  botId: string,
  result: HistoryResult,
  radius = CONTEXT_ROWS
): Promise<HistoryAround> {
  const size = Math.max(1, Math.min(Math.trunc(radius), CONTEXT_ROWS));
  const sessionId = await contextSession(botId, result);
  if (!sessionId) {
    return { ...result, after: [], before: [] };
  }
  const located = { ...result, sessionId };
  const anchor = new Date(result.createdAt);
  const [before, after] = await Promise.all([
    contextRows(botId, located, anchor, "before", size),
    contextRows(botId, located, anchor, "after", size),
  ]);
  return {
    ...located,
    after,
    before: before.toReversed(),
  };
}

/** Resolve the primary conversation from persisted delivery facts, never by recency. */
async function contextSession(
  botId: string,
  result: HistoryResult
): Promise<string | null> {
  if (result.source === "event") {
    return result.sessionId;
  }
  const query =
    result.source === "message"
      ? sql`
      select e.session_id as "sessionId"
      from ${messages} m
      inner join ${events} e on e.data->'data'->>'deliveryId' = m.delivery_id
      where m.bot_id = ${botId}::uuid and m.id::text = ${result.id}
        and e.bot_id = ${botId}::uuid and e.type = 'delivery.consumed'
        and not exists (select 1 from ${consultations} c where c.child_session_id = e.session_id)
      order by e.at asc, e.line asc limit 1
    `
      : sql`
      select mm.session_id as "sessionId"
      from public.memory_metadata mm inner join ${bots} b on b.slug = mm.bot_slug
      where b.id = ${botId}::uuid
        and b.slug || ':memory:' || mm.entry_id = ${result.id}
      limit 1
    `;
  const rows = resultRows<{ sessionId: string | null }>(
    await db().execute(query)
  );
  return rows[0]?.sessionId ?? null;
}

async function contextRows(
  botId: string,
  result: HistoryResult,
  anchor: Date,
  direction: "before" | "after",
  limit: number
): Promise<HistoryResult[]> {
  const comparison = direction === "before" ? sql`<` : sql`>`;
  const order = direction === "before" ? sql`desc` : sql`asc`;
  // Preserve Postgres microseconds for message anchors; JSON dates only retain milliseconds.
  const anchorTimestamp =
    result.source === "memory"
      ? sql`${anchor.toISOString()}::timestamptz`
      : sql`(select "createdAt" from documents where id = ${result.id} limit 1)`;
  const raw = await db().execute<StoredResult>(sql`
    with documents as (
      select
        m.id::text as id,
        m.created_at as "createdAt",
        'user'::text as role,
        m.text as text,
        location.session_id as "sessionId",
        location.turn_id as "turnId",
        'message'::text as source
      from ${messages} m
      inner join lateral (
        select e.session_id, coalesce(e.data->'scope'->>'turnId', e.data->'data'->>'turnId') as turn_id
        from ${events} e
        where e.bot_id = ${botId}::uuid and e.type = 'delivery.consumed'
          and e.data->'data'->>'deliveryId' = m.delivery_id
          and e.session_id = ${result.sessionId}
        order by e.at asc, e.line asc limit 1
      ) location on true
      where m.bot_id = ${botId}::uuid and m.status = 'accepted'
      union all
      select
        e.session_id || ':' || e.line::text || ':' || e.index::text as id,
        e.at as "createdAt",
        'assistant'::text as role,
        e.data->'data'->>'value' as text,
        e.session_id as "sessionId",
        coalesce(e.data->'scope'->>'turnId', e.data->'data'->>'turnId') as "turnId",
        'event'::text as source
      from ${events} e
      where e.bot_id = ${botId}::uuid
        and e.type = 'content.completed'
        and e.data->'data'->>'kind' = 'text'
        and e.data->'data'->>'phase' = 'reply'
        and not exists (
          select 1 from ${consultations} c where c.child_session_id = e.session_id
        )
        and e.session_id = ${result.sessionId}
    )
    select id, "createdAt", role, text, "sessionId", "turnId", source, 0::double precision as score
    from documents
    where id <> ${result.id}
      and ("createdAt", id) ${comparison} (${anchorTimestamp}, ${result.id})
    order by "createdAt" ${order}, id ${order}
    limit ${limit}
  `);
  return resultRows<StoredResult>(raw).map(resultOf);
}

export const historySearchLimits = {
  defaultResults: DEFAULT_RESULTS,
  maxQueryLength: MAX_QUERY_LENGTH,
  maxResults: MAX_RESULTS,
};
