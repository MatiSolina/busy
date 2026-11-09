import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import { getBot } from "@/lib/bots/service";
import { db, memories } from "@/lib/db";
import {
  appendMemoryEntry,
  formatMemoryDocument,
  parseMemoryDoc,
  removeMemoryEntry,
  replaceMemoryEntry,
} from "@/lib/memory-doc";
import {
  legacyMetadata,
  listMemoryMetadata,
  type MemoryMetadata,
  syncMemoryMetadata,
} from "@/lib/memory-metadata";

interface Ctx {
  params: Promise<{ slug: string }>;
}

const ENTRY_ID = /^\d+$/u;
const MAX_MEMORY_BODY_BYTES = 64 * 1024;
const EMPTY_MEMORY_DOCUMENT = formatMemoryDocument({
  entries: [],
  lastAllocatedIndex: -1,
});

type MemoryEntryResponse = ReturnType<typeof responseEntry>;

function memoryJson(data: unknown, status = 200) {
  return Response.json(data, {
    headers: { "Cache-Control": "private, no-store" },
    status,
  });
}

async function currentUser(): Promise<string | null> {
  const devBypass =
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1";
  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret)
    : null;
  return session?.user ?? (devBypass ? (process.env.BUSY_USER ?? "dev") : null);
}

async function jsonBody(req: Request): Promise<unknown> {
  const contentLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > MAX_MEMORY_BODY_BYTES) {
    throw new Error("memory payload is too large");
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).byteLength > MAX_MEMORY_BODY_BYTES) {
    throw new Error("memory payload is too large");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("invalid JSON", { cause: error });
  }
}

function responseEntry(
  botSlug: string,
  entry: { id: string; text: string },
  metadata: MemoryMetadata | undefined
) {
  const source = metadata ?? legacyMetadata(botSlug, entry);
  return {
    author: source.author,
    createdAt: source.createdAt,
    id: entry.id,
    messageId: source.messageId,
    origin: source.origin,
    sourceStatus: source.sourceStatus,
    text: entry.text,
    turnId: source.turnId,
    updatedAt: source.updatedAt,
  };
}

async function readEntries(
  slug: string,
  query = ""
): Promise<{ entries: MemoryEntryResponse[]; version: number | null }> {
  const [row] = await db()
    .select()
    .from(memories)
    .where(eq(memories.botSlug, slug));
  const parsed = row ? parseMemoryDoc(row.content) : [];
  const metadata = await listMemoryMetadata(db(), slug);
  const byId = new Map(metadata.map((item) => [item.entryId, item]));
  const needle = query.trim().toLocaleLowerCase();
  const entries = parsed
    .filter(
      (entry) => !needle || entry.text.toLocaleLowerCase().includes(needle)
    )
    .map((entry) => responseEntry(slug, entry, byId.get(entry.id)));
  return { entries, version: row?.version ?? null };
}

async function requireBot(slug: string) {
  const bot = await getBot(slug);
  return bot ?? null;
}

function ownerSource(user: string) {
  return {
    author: user,
    messageId: null,
    origin: "owner" as const,
    sessionId: null,
    sourceStatus: "trusted_user" as const,
    turnId: null,
  };
}

async function writeDocument(
  slug: string,
  content: string,
  expectedVersion: number | null,
  source: ReturnType<typeof ownerSource>
) {
  return await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`busy:memory:${slug}`}))`
    );
    const [row] = await tx
      .select()
      .from(memories)
      .where(eq(memories.botSlug, slug))
      .for("update");
    const actualVersion = row?.version ?? null;
    if (actualVersion !== expectedVersion) {
      return { conflict: true as const, version: actualVersion };
    }
    const nextVersion = (row?.version ?? 0) + 1;
    const previousContent = row?.content ?? null;
    const written = row
      ? await tx
          .update(memories)
          .set({ content, version: nextVersion })
          .where(
            and(
              eq(memories.botSlug, slug),
              eq(memories.version, actualVersion ?? 0)
            )
          )
          .returning()
      : await tx
          .insert(memories)
          .values({ botSlug: slug, content, version: nextVersion })
          .returning();
    const [saved] = written;
    if (!saved) {
      return { conflict: true as const, version: actualVersion };
    }
    await syncMemoryMetadata(tx, {
      botSlug: slug,
      content,
      documentVersion: saved.version,
      previousContent,
      source,
    });
    return { conflict: false as const, version: saved.version };
  });
}

export async function GET(req: Request, { params }: Ctx) {
  if (!(await currentUser())) {
    return memoryJson({ error: "unauthorized" }, 401);
  }
  const { slug } = await params;
  if (!(await requireBot(slug))) {
    return memoryJson({ error: "not_found" }, 404);
  }
  const query = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (query.length > 200) {
    return memoryJson({ error: "invalid_query" }, 400);
  }
  return memoryJson(await readEntries(slug, query));
}

export async function POST(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) {
    return memoryJson({ error: "unauthorized" }, 401);
  }
  const { slug } = await params;
  if (!(await requireBot(slug))) {
    return memoryJson({ error: "not_found" }, 404);
  }
  let parsed: { expectedVersion?: number | null; text: string };
  try {
    parsed = z
      .object({
        expectedVersion: z.number().int().nonnegative().nullable().optional(),
        text: z.string().min(1),
      })
      .parse(await jsonBody(req));
  } catch {
    return memoryJson({ error: "bad_request" }, 400);
  }
  const [row] = await db()
    .select()
    .from(memories)
    .where(eq(memories.botSlug, slug));
  const expectedVersion = parsed.expectedVersion ?? row?.version ?? null;
  try {
    const { content, entry } = appendMemoryEntry(
      row?.content ?? EMPTY_MEMORY_DOCUMENT,
      parsed.text
    );
    if (!entry) {
      if ((row?.version ?? null) !== expectedVersion) {
        return memoryJson(
          { error: "conflict", version: row?.version ?? null },
          409
        );
      }
      return memoryJson(await readEntries(slug));
    }
    const result = await writeDocument(
      slug,
      content,
      expectedVersion,
      ownerSource(user)
    );
    if (result.conflict) {
      return memoryJson({ error: "conflict", version: result.version }, 409);
    }
    return memoryJson(await readEntries(slug));
  } catch (error) {
    return memoryJson(
      { error: error instanceof Error ? error.message : "bad_request" },
      400
    );
  }
}

export async function PATCH(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) {
    return memoryJson({ error: "unauthorized" }, 401);
  }
  const { slug } = await params;
  if (!(await requireBot(slug))) {
    return memoryJson({ error: "not_found" }, 404);
  }
  let parsed: {
    entryId: string;
    expectedVersion?: number | null;
    text: string;
  };
  try {
    parsed = z
      .object({
        entryId: z.string().regex(ENTRY_ID),
        expectedVersion: z.number().int().nonnegative().nullable().optional(),
        text: z.string().min(1),
      })
      .parse(await jsonBody(req));
  } catch {
    return memoryJson({ error: "bad_request" }, 400);
  }
  const [row] = await db()
    .select()
    .from(memories)
    .where(eq(memories.botSlug, slug));
  if (!row) {
    return memoryJson({ error: "not_found" }, 404);
  }
  const expectedVersion = parsed.expectedVersion ?? row.version;
  try {
    const content = replaceMemoryEntry(
      row.content,
      parsed.entryId,
      parsed.text
    );
    const result = await writeDocument(
      slug,
      content,
      expectedVersion,
      ownerSource(user)
    );
    if (result.conflict) {
      return memoryJson({ error: "conflict", version: result.version }, 409);
    }
    return memoryJson(await readEntries(slug));
  } catch (error) {
    return memoryJson(
      { error: error instanceof Error ? error.message : "bad_request" },
      400
    );
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const user = await currentUser();
  if (!user) {
    return memoryJson({ error: "unauthorized" }, 401);
  }
  const { slug } = await params;
  if (!(await requireBot(slug))) {
    return memoryJson({ error: "not_found" }, 404);
  }
  let parsed: { entryId: string; expectedVersion?: number | null };
  try {
    parsed = z
      .object({
        entryId: z.string().regex(ENTRY_ID),
        expectedVersion: z.number().int().nonnegative().nullable().optional(),
      })
      .parse(await jsonBody(req));
  } catch {
    return memoryJson({ error: "bad_request" }, 400);
  }
  const [row] = await db()
    .select()
    .from(memories)
    .where(eq(memories.botSlug, slug));
  if (!row) {
    return memoryJson({ entries: [], version: null });
  }
  const expectedVersion = parsed.expectedVersion ?? row.version;
  try {
    const content = removeMemoryEntry(row.content, parsed.entryId);
    const result = await writeDocument(
      slug,
      content,
      expectedVersion,
      ownerSource(user)
    );
    if (result.conflict) {
      return memoryJson({ error: "conflict", version: result.version }, 409);
    }
    return memoryJson(await readEntries(slug));
  } catch (error) {
    if (error instanceof Error && error.message === "Memory entry not found.") {
      return memoryJson({ error: "not_found" }, 404);
    }
    return memoryJson(
      { error: error instanceof Error ? error.message : "bad_request" },
      400
    );
  }
}
