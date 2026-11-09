import { createHash, randomUUID } from "node:crypto";
import { del, issueSignedToken, list, presignUrl } from "@vercel/blob";
import { and, desc, eq, isNull, like, ne, or, sql } from "drizzle-orm";
import {
  isSensitiveArtifactName,
  isTextArtifact,
  MAX_SCANNABLE_TEXT_BYTES,
  scanTextArtifact,
} from "./artifact-safety";
import { type BotRow, bots, db, files } from "./db";
import { sha256Response } from "./library-content";

const MAX_BYTES = 200 * 1024 * 1024;
const EXPIRE_LIMIT = 100;
const UNSAFE_PATH_CHARS = /[^\w .()+,'-]/gu;
/** Signed read URLs remain valid for this many minutes. */
export const READ_MINUTES = 10;

// Path-safe but readable, and the one key for a file: versions are counted by it, it's what the bot
// and the user see, and the path is built from it, so two raw names that clean up the same ("a/b",
// "a_b"; NFD and NFC) share a version sequence instead of colliding on one path.
export const fileKey = (name: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: These ranges deliberately reject control characters from blob paths.
  name.normalize("NFC").replace(/[/\\\u0000-\u001f\u007f-\u009f]/gu, "_");

/** Signed upload (PUT) URLs remain valid for this many minutes. */
export const UPLOAD_MINUTES = 15;
/**
 * A pending reservation may complete for this long after it was made: the PUT URL's lifetime plus a
 * grace for an upload that started just before the URL expired. Past it the reservation is expired:
 * completion refuses it and the library verification cron removes the row and its Blob. Matches the
 * backfill in drizzle/0029.
 */
export const PENDING_MINUTES = UPLOAD_MINUTES + 45;
// The deadline of a pending row; legacy rows written without pending_until use their creation time.
const pendingDeadline = sql`coalesce(${files.pendingUntil}, ${files.createdAt} + make_interval(mins => ${PENDING_MINUTES}))`;
const botIsLive = sql`exists (select 1 from ${bots} where ${bots.id} = ${files.botId} and ${bots.deletionState} is null)`;

/** The bot is being deleted (or is gone): it takes no new files. */
export class BotUnavailableError extends Error {
  constructor() {
    super("bot is being deleted");
    this.name = "BotUnavailableError";
  }
}

export const isBotUnavailable = (error: unknown) =>
  error instanceof Error && error.name === "BotUnavailableError";

/**
 * Where a new reservation's bytes go: under the bot's immutable id and the reservation's own id, so a
 * late signed PUT of a deleted bot (or of another reservation) can never land on a path that a bot
 * reusing the slug, or a later version, needs. Slug and version stay presentation only.
 */
export function blobPathname(
  botId: string,
  fileId: string,
  name: string
): string {
  const key = fileKey(name);
  // @vercel/blob 2.8.2 signs non-ASCII paths as Latin-1 (presign throws), and '#', '?', '%' upload
  // but then 403 on read (#197). Keep the blob path to safe ASCII; the hash of the full name keeps
  // two names from sharing one even under the same reservation id.
  const safe = key.replace(UNSAFE_PATH_CHARS, "_");
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
  return `bots/${botId}/${fileId}-${hash}-${safe}`;
}

/**
 * The folders a bot's uploads can live in: the stable id prefix, plus the legacy slug prefix that
 * reservations used before paths were id-based (`bots/<slug>/<version>-<name>`). Readers never derive
 * a path, they read `files.pathname`, so both formats keep working.
 */
export const botBlobPrefixes = (bot: Pick<BotRow, "id" | "slug">) => [
  `bots/${bot.id}/`,
  `bots/${bot.slug}/`,
];

/**
 * Everything under the bot's folders that no other bot's file points to. The id prefix is only ever
 * written for this bot; the legacy slug prefix may be shared with a new bot that took the slug, so the
 * reference check spares any path another bot's row (current or stale) still names.
 */
export async function deleteBotBlobs(
  bot: Pick<BotRow, "id" | "slug">
): Promise<void> {
  for (const prefix of botBlobPrefixes(bot)) {
    // biome-ignore lint/performance/noAwaitInLoops: One prefix at a time keeps each reference check bounded.
    await deletePrefixBlobs(bot.id, prefix);
  }
}

async function deletePrefixBlobs(botId: string, prefix: string) {
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: Pagination must consume one cursor before requesting the next.
    const page = await list({ cursor, prefix });
    // Read after listing, never before: an upload reserves its row before its PUT, so any listed blob of
    // a new bot that took the slug has its row by now.
    const others = await db()
      .select({ pathname: files.pathname, stalePathname: files.stalePathname })
      .from(files)
      .where(
        and(
          or(
            like(files.pathname, `${prefix}%`),
            like(files.stalePathname, `${prefix}%`)
          ),
          ne(files.botId, botId)
        )
      );
    const kept = new Set(
      others.flatMap(({ pathname, stalePathname }) =>
        [pathname, stalePathname].filter((path): path is string =>
          Boolean(path)
        )
      )
    );
    const gone = page.blobs
      .filter((b) => !kept.has(b.pathname))
      .map((b) => b.url);
    if (gone.length) {
      await del(gone);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
}

export const nextVersion = (existing: number[]) => Math.max(0, ...existing) + 1;

export const fileInput = { maxBytes: MAX_BYTES, maxNameLength: 200 };

async function readForSafety(
  response: Response
): Promise<Uint8Array | undefined> {
  if (!(response.ok && response.body)) {
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: A stream reader must consume chunks in order.
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > MAX_SCANNABLE_TEXT_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function blockSensitiveBotFile(
  fileId: string,
  pathname: string
): Promise<void> {
  // Keep the row as a tombstone so it cannot be attached to a message or
  // library object. The stale path is retried by the existing cleanup sweep
  // if Blob is temporarily unavailable.
  await db()
    .update(files)
    .set({
      stalePathname: pathname,
      staleUntil: new Date(Date.now() + READ_MINUTES * 60_000),
      status: "blocked",
    })
    // Only an unfinished reservation is blocked: a row that a racing completion already published,
    // or that an expiry already took, is not rewritten.
    .where(and(eq(files.id, fileId), eq(files.status, "pending")));
  await del(pathname).catch(() => undefined);
}

async function botArtifactSafetyReason(
  name: string,
  contentType: string,
  pathname: string,
  size: number
): Promise<string | null> {
  if (isSensitiveArtifactName(name)) {
    return "sensitive_filename";
  }
  const declaredText = isTextArtifact(contentType, name);
  // Small uploads are sniffed regardless of MIME/name; only declared text is
  // rejected when it exceeds the bounded scan size. PDF/DOCX extraction is
  // intentionally outside this path.
  if (size > MAX_SCANNABLE_TEXT_BYTES) {
    return declaredText ? "unscannable_text" : null;
  }
  const body = await fetch(await readUrl(pathname)).catch(() => null);
  const bytes = body ? await readForSafety(body) : null;
  if (!(body && bytes)) {
    return "unavailable";
  }
  return scanTextArtifact(name, contentType, bytes);
}

/**
 * Reserves a row and returns where to PUT the bytes (spec 4.4). The id is chosen before the URL is
 * signed and the path is derived from it, so two reservations never share a path.
 */
export async function registerFile(
  bot: BotRow,
  f: { name: string; contentType: string; size: number },
  source: "user" | "bot",
  attempt = 0
): Promise<{ fileId: string; uploadUrl: string }> {
  const name = fileKey(f.name);
  const versions = await db()
    .select({ version: files.version })
    .from(files)
    .where(and(eq(files.botId, bot.id), eq(files.name, name)));
  const version = nextVersion(versions.map((v) => v.version));
  const id = randomUUID();
  const pathname = blobPathname(bot.id, id, name);
  const row = await db().transaction(async (tx) => {
    // Shares the bot row with requestBotDeletion's UPDATE: a reservation either commits before the
    // bot is marked deleting (and goes with it) or sees the mark and is refused.
    const [live] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(and(eq(bots.id, bot.id), isNull(bots.deletionState)))
      .for("share");
    if (!live) {
      throw new BotUnavailableError();
    }
    const [inserted] = await tx
      .insert(files)
      .values({
        botId: bot.id,
        contentType: f.contentType,
        id,
        name,
        pathname,
        pendingUntil: sql`now() + make_interval(mins => ${PENDING_MINUTES})`,
        size: f.size,
        source,
        version,
      })
      .onConflictDoNothing()
      .returning({ id: files.id });
    return inserted;
  });
  // Two uploads of the same name at once picked the same version: take the next one.
  if (!row) {
    if (attempt >= 3) {
      throw new Error("could not reserve a file version");
    }
    return registerFile(bot, f, source, attempt + 1);
  }
  return {
    fileId: row.id,
    uploadUrl: await uploadUrl(pathname, f.size, f.contentType),
  };
}

/** A one-file presigned PUT: the client uploads straight to Blob, never through a Function. */
async function uploadUrl(
  pathname: string,
  size: number,
  contentType: string
): Promise<string> {
  const validUntil = Date.now() + UPLOAD_MINUTES * 60_000;
  const maximumSizeInBytes = Math.min(size + 1024, MAX_BYTES);
  const token = await issueSignedToken({
    maximumSizeInBytes,
    operations: ["put"],
    pathname,
    validUntil,
  });
  const { presignedUrl } = await presignUrl(token, {
    access: "private",
    addRandomSuffix: false,
    allowedContentTypes: [contentType],
    allowOverwrite: false,
    maximumSizeInBytes,
    operation: "put",
    pathname,
    validUntil,
  });
  return presignedUrl;
}

export async function completeFile(
  botId: string,
  fileId: string
): Promise<boolean> {
  const [reserved] = await db()
    .select({
      contentType: files.contentType,
      name: files.name,
      pathname: files.pathname,
      size: files.size,
      source: files.source,
      status: files.status,
    })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.botId, botId)));
  if (
    !reserved ||
    reserved.status === "ready" ||
    reserved.status === "blocked"
  ) {
    return reserved?.status === "ready";
  }
  const response = await fetch(await readUrl(reserved.pathname, "head"), {
    // Compression can omit Content-Length; verify the original stored bytes.
    headers: { "accept-encoding": "identity" },
    method: "HEAD",
  }).catch(() => null);
  const contentLength = Number(response?.headers.get("content-length"));
  if (
    !(
      response?.ok &&
      Number.isSafeInteger(contentLength) &&
      contentLength === reserved.size
    )
  ) {
    return false;
  }

  if (reserved.source === "bot") {
    const reason = await botArtifactSafetyReason(
      reserved.name,
      reserved.contentType,
      reserved.pathname,
      reserved.size
    );
    if (reason === "unavailable") {
      return false;
    }
    if (reason) {
      await blockSensitiveBotFile(fileId, reserved.pathname);
      return false;
    }
  }

  // The reservation is published only while it is still pending, inside its deadline and its bot is
  // not being deleted. The expiry sweep acts only past the deadline (database clock on both sides),
  // so a completion and a sweep can never both win the same row.
  const done = await db()
    .update(files)
    .set({ status: "ready" })
    .where(
      and(
        eq(files.id, fileId),
        eq(files.botId, botId),
        eq(files.status, "pending"),
        sql`${pendingDeadline} > now()`,
        botIsLive
      )
    )
    .returning({ id: files.id });
  if (done.length > 0) {
    return true;
  }
  // An overlapping completion may have published the same immutable bytes.
  // Re-read only this bot's row; a blocked, expired or deleted file remains a failure.
  const [current] = await db()
    .select({ status: files.status })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.botId, botId)));
  return current?.status === "ready";
}

/**
 * Expire upload reservations past their deadline (H-37), in a bounded batch. Each row is fenced by its
 * deadline first (completion can no longer publish it), then its Blob is removed when no other row
 * names that path, and only then the row: a Blob failure leaves the row for the next run, and a
 * second run over the same rows is a no-op. Ready, blocked and stale-path rows are never touched.
 */
export async function expirePendingFiles(limit = EXPIRE_LIMIT) {
  const candidates = await db()
    .select({ id: files.id, pathname: files.pathname })
    .from(files)
    .where(and(eq(files.status, "pending"), sql`${pendingDeadline} <= now()`))
    .limit(Math.min(Math.max(limit, 1), EXPIRE_LIMIT));
  let expired = 0;
  for (const candidate of candidates) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Each reservation's reference check, Blob delete and row delete stay ordered.
      if (await expireReservation(candidate)) {
        expired += 1;
      }
    } catch {
      // Blob or database unavailable: the reservation stays pending and expired for the next run.
    }
  }
  return expired;
}

async function expireReservation({
  id,
  pathname,
}: {
  id: string;
  pathname: string;
}): Promise<boolean> {
  const [shared] = await db()
    .select({ id: files.id })
    .from(files)
    .where(
      and(
        or(eq(files.pathname, pathname), eq(files.stalePathname, pathname)),
        ne(files.id, id)
      )
    )
    .limit(1);
  // A reservation never holds a canonical library path, and an id-based path is its own; a legacy
  // slug path another row names (a bot that reused the slug) keeps its bytes.
  if (!(shared || pathname.startsWith("library/"))) {
    await del(pathname);
  }
  const [gone] = await db()
    .delete(files)
    .where(
      and(
        eq(files.id, id),
        eq(files.status, "pending"),
        sql`${pendingDeadline} <= now()`
      )
    )
    .returning({ id: files.id });
  return Boolean(gone);
}

/**
 * Read an uploaded Blob through a short-lived signed URL and hash the bytes on
 * the server. Call this before attaching an object to a content-addressed
 * library row; client supplied hashes are only hints and never authority.
 */
export async function verifyFileBytes(botId: string, fileId: string) {
  const [row] = await db()
    .select({ pathname: files.pathname, size: files.size })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.botId, botId)));
  if (!row) {
    throw new Error("file not found");
  }
  const response = await fetch(await readUrl(row.pathname));
  return sha256Response(response, row.size);
}

/** A fresh read URL scoped to its HTTP operation; GET signatures cannot serve HEAD. */
export async function readUrl(
  pathname: string,
  operation: "get" | "head" = "get"
): Promise<string> {
  const validUntil = Date.now() + READ_MINUTES * 60_000;
  const token = await issueSignedToken({
    operations: [operation],
    pathname,
    validUntil,
  });
  return (
    await presignUrl(token, {
      access: "private",
      operation,
      pathname,
      validUntil,
    })
  ).presignedUrl;
}

export async function fileForMessage(botId: string, fileId: string) {
  const [row] = await db()
    .select()
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.botId, botId),
        eq(files.status, "ready")
      )
    );
  if (!row) {
    throw new Error("file not found");
  }
  return {
    filename: row.name,
    mediaType: row.contentType,
    url: await readUrl(row.pathname),
  };
}

/** A bot's chat files, newest first: what it sent and what the user sent it. */
export async function chatFiles(botId: string) {
  return await db()
    .select({
      createdAt: files.createdAt,
      id: files.id,
      name: files.name,
      size: files.size,
      source: files.source,
      version: files.version,
    })
    .from(files)
    .where(and(eq(files.botId, botId), eq(files.status, "ready")))
    .orderBy(desc(files.createdAt))
    .limit(50);
}
