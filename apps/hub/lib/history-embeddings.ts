import { randomUUID } from "node:crypto";
import { getVercelOidcToken } from "@vercel/oidc";
import { sql } from "drizzle-orm";
import { db, events, messages } from "@/lib/db";

const table = sql.raw("public.history_embeddings");

interface Pending extends Record<string, unknown> {
  botId: string;
  contentHash: string;
  id: string;
  model: string;
  sessionId: string | null;
  source: "event" | "memory" | "message";
  text: string;
  turnId: string | null;
}

function model(): string | null {
  return process.env.HISTORY_EMBEDDINGS_ENABLED === "1"
    ? process.env.HISTORY_EMBEDDING_MODEL?.trim() || null
    : null;
}

function rows<T>(value: unknown): T[] {
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

async function ensureRows(botId: string | null, embeddingModel: string) {
  await db().execute(sql`
    with documents as (
      select m.bot_id, 'message'::text as source, m.id::text as source_id,
        null::text as session_id, null::text as turn_id, m.text,
        m.created_at as source_created_at
      from ${messages} m
      where m.status = 'accepted' and length(btrim(m.text)) > 0
        ${botId ? sql`and m.bot_id = ${botId}::uuid` : sql``}
      union all
      select b.id, 'memory'::text, b.slug || ':memory:' || mm.entry_id,
        null::text, null::text, mm.text, mm.updated_at
      from public.memory_metadata mm
      inner join public.bots b on b.slug = mm.bot_slug
      where length(btrim(mm.text)) > 0
        ${botId ? sql`and b.id = ${botId}::uuid` : sql``}
      union all
      select e.bot_id, 'event'::text, e.session_id || ':' || e.line::text || ':' || e.index::text,
        e.session_id, coalesce(e.data->'scope'->>'turnId', e.data->'data'->>'turnId'),
        e.data->'data'->>'value', e.at
      from ${events} e
      where e.type = 'content.completed'
        and e.data->'data'->>'kind' = 'text'
        and e.data->'data'->>'phase' = 'reply'
        and length(btrim(coalesce(e.data->'data'->>'value', ''))) > 0
        and not exists (
          select 1 from public.consultations c where c.child_session_id = e.session_id
        )
        ${botId ? sql`and e.bot_id = ${botId}::uuid` : sql``}
    )
    insert into ${table} (
      bot_id, source, source_id, session_id, turn_id, text, created_at,
      content_hash, model
    )
    select
      bot_id, source, source_id, session_id, turn_id, text, source_created_at,
      md5(text), ${embeddingModel}
    from documents
    on conflict (bot_id, source, source_id, model) do update set
      text = excluded.text,
      created_at = excluded.created_at,
      content_hash = excluded.content_hash,
      session_id = excluded.session_id,
      turn_id = excluded.turn_id,
      embedding = case when ${table}.content_hash <> excluded.content_hash then null else ${table}.embedding end,
      lease_token = case when ${table}.content_hash <> excluded.content_hash then null else ${table}.lease_token end,
      lease_until = case when ${table}.content_hash <> excluded.content_hash then null else ${table}.lease_until end,
      updated_at = now()
  `);
}

async function embed(input: readonly string[]): Promise<number[][]> {
  const endpoint =
    process.env.HISTORY_EMBEDDING_URL?.trim() ||
    "https://ai-gateway.vercel.sh/v1/embeddings";
  const isGateway = endpoint === "https://ai-gateway.vercel.sh/v1/embeddings";
  const token =
    process.env.HISTORY_EMBEDDING_API_KEY?.trim() ||
    (isGateway ? process.env.AI_GATEWAY_API_KEY?.trim() : undefined) ||
    (isGateway ? await getVercelOidcToken() : null);
  if (!token) {
    throw new Error(
      "A custom embedding endpoint requires HISTORY_EMBEDDING_API_KEY."
    );
  }
  const response = await fetch(endpoint, {
    body: JSON.stringify({ input, model: model() }),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`embedding provider returned ${response.status}`);
  }
  const body = (await response.json()) as {
    data?: { embedding?: unknown; index?: unknown }[];
  };
  const data = body.data ?? [];
  if (data.length !== input.length) {
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
        index >= input.length
    ) ||
    new Set(indexed.map(({ index }) => index)).size !== input.length
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

/** One bounded durable batch. Pending rows remain retryable after a provider error. */
export async function historyEmbeddingBatch(
  botId: string | null = null
): Promise<boolean> {
  const embeddingModel = model();
  if (!embeddingModel) {
    return false;
  }
  await ensureRows(botId, embeddingModel);
  const leaseToken = randomUUID();
  const pending = await db().transaction(async (tx) => {
    const raw = await tx.execute<Pending>(sql`
      select bot_id as "botId", source, source_id as id, session_id as "sessionId",
        turn_id as "turnId", text, content_hash as "contentHash", model
      from ${table}
      where model = ${embeddingModel} and embedding is null
        and next_attempt_at <= now()
        and (lease_until is null or lease_until < now())
        ${botId ? sql`and bot_id = ${botId}::uuid` : sql``}
      order by updated_at asc
      limit 32
      for update skip locked
    `);
    const picked = rows<Pending>(raw);
    if (picked.length) {
      const predicates = picked.map(
        (row) =>
          sql`(bot_id = ${row.botId}::uuid and source = ${row.source} and source_id = ${row.id} and model = ${row.model})`
      );
      await tx.execute(sql`
        update ${table}
        set lease_token = ${leaseToken}::uuid,
            lease_until = now() + interval '2 minutes',
            updated_at = now()
        where ${sql.join(predicates, sql` or `)}
      `);
    }
    return picked;
  });
  if (!pending.length) {
    return false;
  }
  let vectors: number[][];
  try {
    vectors = await embed(pending.map((row) => row.text));
  } catch {
    await db().execute(sql`
      update ${table}
      set attempts = attempts + 1,
          next_attempt_at = now() + interval '5 minutes',
          lease_token = null,
          lease_until = null,
          updated_at = now()
      where model = ${embeddingModel} and lease_token = ${leaseToken}::uuid
    `);
    return false;
  }
  await db().transaction(async (tx) => {
    for (const [index, row] of pending.entries()) {
      const vector = vectors[index];
      if (!vector) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Each update is keyed by a durable source row and must be applied serially in this transaction.
      await tx.execute(sql`
        update ${table}
        set embedding = ${JSON.stringify(vector)}::jsonb,
            attempts = attempts + 1,
            lease_token = null,
            lease_until = null,
            updated_at = now()
        where bot_id = ${row.botId}::uuid and source = ${row.source}
          and source_id = ${row.id} and model = ${embeddingModel}
          and lease_token = ${leaseToken}::uuid
      `);
    }
  });
  return pending.length === 32;
}
