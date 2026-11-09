import { performance } from "node:perf_hooks";
import { del, put } from "@vercel/blob";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { bots, db, files, libraryObjects } from "@/lib/db";
import { READ_MINUTES, readUrl, verifyFileBytes } from "./files";
import { objectPathForSha256 } from "./library-content";
import {
  observeOperation,
  operationErrorCode,
} from "./operation-observability";

const BLOB_CONFLICT = /already exists|conflict|409/iu;
const CANONICAL_PATH = /^library\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}$/u;
const STALE_UPLOAD_LIMIT = 100;
const ORPHAN_OBJECT_LIMIT = 100;

const digestLockKey = (sha256: string) => `busy:library-object:${sha256}`;

async function lockDigest(tx: LibraryTransaction, sha256: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${digestLockKey(sha256)}))`
  );
}

export interface FileProvenance {
  messageId?: string | null;
  sessionId?: string | null;
  turnId?: string | null;
}

export interface FilePromotion {
  fileId: string;
  objectId: string;
  pathname: string;
  reused: boolean;
  sha256: string;
  size: number;
  stalePathname?: string;
}

interface LibraryObjectRow {
  id: string;
  pathname: string;
  sha256: string;
  size: number;
  status: "pending" | "ready";
}

type LibraryTransaction = Parameters<
  Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

interface CurrentFile {
  contentType: string;
  id: string;
  pathname: string;
  size: number;
  status: string;
}

interface VerifiedBytes {
  sha256: string;
  size: number;
}

async function findOrCreateObject(
  tx: LibraryTransaction,
  current: CurrentFile,
  verified: VerifiedBytes,
  pathname: string
) {
  let [object] = await tx
    .select()
    .from(libraryObjects)
    .where(eq(libraryObjects.sha256, verified.sha256))
    .for("update");
  let reused = Boolean(object);
  if (!object) {
    const [inserted] = await tx
      .insert(libraryObjects)
      .values({
        contentType: current.contentType,
        pathname,
        sha256: verified.sha256,
        size: verified.size,
        status: "ready",
      })
      .onConflictDoNothing({ target: libraryObjects.sha256 })
      .returning();
    object = inserted;
    if (!object) {
      [object] = await tx
        .select()
        .from(libraryObjects)
        .where(eq(libraryObjects.sha256, verified.sha256))
        .for("update");
      reused = true;
    }
  }
  if (!object) {
    throw new Error("could not create library object");
  }
  if (object.status !== "ready") {
    [object] = await tx
      .update(libraryObjects)
      .set({ status: "ready" })
      .where(eq(libraryObjects.id, object.id))
      .returning();
  }
  if (!object) {
    throw new Error("could not activate library object");
  }
  return { object, reused };
}

async function blobHasSize(pathname: string, size: number) {
  const response = await fetch(await readUrl(pathname, "head"), {
    // Compression can omit Content-Length; verify the original stored bytes.
    headers: { "accept-encoding": "identity" },
    method: "HEAD",
  }).catch(() => null);
  const contentLength = Number(response?.headers.get("content-length"));
  return Boolean(
    response?.ok &&
      Number.isSafeInteger(contentLength) &&
      contentLength === size
  );
}

async function ensureObjectStorage(
  current: CurrentFile,
  pathname: string,
  size: number
) {
  if (await blobHasSize(pathname, size)) {
    return pathname;
  }
  if (current.pathname === pathname) {
    throw new Error("verified object bytes are no longer available");
  }
  const response = await fetch(await readUrl(current.pathname));
  if (!(response.ok && response.body)) {
    throw new Error("could not read uploaded file for canonical storage");
  }
  try {
    await put(pathname, response.body, {
      access: "private",
      addRandomSuffix: false,
      contentType: current.contentType,
    });
  } catch (error) {
    // Concurrent duplicate uploads may race to create the same canonical
    // pathname. Their verified bytes have the same digest, so an existing
    // object is safe to reuse; other Blob errors must retry the workflow.
    if (!(error instanceof Error && BLOB_CONFLICT.test(error.message))) {
      throw error;
    }
  }
  if (!(await blobHasSize(pathname, size))) {
    throw new Error("canonical object could not be verified");
  }
  return pathname;
}

async function attachFileToObject(
  tx: LibraryTransaction,
  current: CurrentFile,
  object: LibraryObjectRow,
  provenance: FileProvenance
) {
  const stalePathname =
    object.pathname === current.pathname ? undefined : current.pathname;
  const [updated] = await tx
    .update(files)
    .set({
      messageId: provenance.messageId ?? undefined,
      objectId: object.id,
      pathname: object.pathname,
      sessionId: provenance.sessionId ?? undefined,
      stalePathname,
      staleUntil: stalePathname
        ? new Date(Date.now() + READ_MINUTES * 60_000)
        : undefined,
      status: "ready",
      turnId: provenance.turnId ?? undefined,
    })
    .where(
      and(
        eq(files.id, current.id),
        eq(files.status, "ready"),
        isNull(files.objectId)
      )
    )
    .returning({ id: files.id });
  if (!updated) {
    throw new Error("file disappeared during verification");
  }
  return {
    fileId: current.id,
    objectId: object.id,
    pathname: object.pathname,
    sha256: object.sha256,
    size: object.size,
    ...(object.pathname === current.pathname
      ? {}
      : { stalePathname: current.pathname }),
  };
}

/**
 * Verify the uploaded bytes and atomically attach the file row to one shared
 * object. The unique digest constraint serializes concurrent duplicate uploads:
 * exactly one row owns the physical pathname and all other references reuse it.
 */
async function promoteVerifiedFileImpl(
  botId: string,
  fileId: string,
  provenance: FileProvenance = {}
): Promise<FilePromotion | null> {
  const [reserved] = await db()
    .select({
      contentType: files.contentType,
      id: files.id,
      objectId: files.objectId,
      pathname: files.pathname,
      size: files.size,
      status: files.status,
    })
    .from(files)
    .where(
      and(
        eq(files.id, fileId),
        eq(files.botId, botId),
        eq(files.status, "ready"),
        isNull(files.objectId)
      )
    );
  if (!reserved || reserved.objectId) {
    return null;
  }

  const verified = await verifyFileBytes(botId, fileId);
  const promotion = await db().transaction(async (tx) => {
    const [current] = await tx
      .select({
        contentType: files.contentType,
        id: files.id,
        pathname: files.pathname,
        size: files.size,
        status: files.status,
      })
      .from(files)
      .where(
        and(
          eq(files.id, fileId),
          eq(files.botId, botId),
          eq(files.status, "ready"),
          isNull(files.objectId),
          // A bot being deleted takes no new references (N-06). A promotion that committed just
          // before the mark is still safe: its reference cascades with the bot's files and the
          // general orphan sweep collects the object.
          sql`exists (select 1 from ${bots} where ${bots.id} = ${files.botId} and ${bots.deletionState} is null)`
        )
      )
      .for("update");
    if (!current) {
      return null;
    }
    if (current.size !== verified.size) {
      throw new Error("uploaded file size changed during verification");
    }

    await lockDigest(tx, verified.sha256);
    const [knownObject] = await tx
      .select({ pathname: libraryObjects.pathname })
      .from(libraryObjects)
      .where(eq(libraryObjects.sha256, verified.sha256))
      .for("update");
    const canonicalPath = await ensureObjectStorage(
      current,
      knownObject?.pathname ?? objectPathForSha256(verified.sha256),
      verified.size
    );
    const { object, reused } = await findOrCreateObject(
      tx,
      current,
      verified,
      canonicalPath
    );
    return {
      ...(await attachFileToObject(tx, current, object, provenance)),
      reused,
    } satisfies FilePromotion;
  });

  return promotion;
}

/** Metadata-only lifecycle wrapper used by verification and direct completion. */
export async function promoteVerifiedFile(
  botId: string,
  fileId: string,
  provenance: FileProvenance = {}
): Promise<FilePromotion | null> {
  const startedAt = performance.now();
  observeOperation({
    botId,
    entryPoint: "workflow",
    flow: "library",
    operationId: fileId,
    outcome: "started",
    stage: "promotion",
  });
  try {
    const promotion = await promoteVerifiedFileImpl(botId, fileId, provenance);
    observeOperation({
      botId,
      durationMs: performance.now() - startedAt,
      entryPoint: "workflow",
      flow: "library",
      operationId: fileId,
      outcome: promotion ? "completed" : "skipped",
      stage: "promotion",
    });
    return promotion;
  } catch (error) {
    observeOperation({
      botId,
      durationMs: performance.now() - startedAt,
      entryPoint: "workflow",
      errorCode: operationErrorCode(error),
      flow: "library",
      operationId: fileId,
      outcome: "failed",
      stage: "promotion",
    });
    throw error;
  }
}

/**
 * Delete promoted uploads after all signed URLs issued for their old path have
 * expired. The cron uses this bounded sweep instead of deleting during
 * promotion, which would invalidate a URL that raced with the promotion.
 */
export async function deleteExpiredStaleUploads(
  now = new Date(),
  limit = STALE_UPLOAD_LIMIT
) {
  const candidates = await db()
    .select({
      id: files.id,
      pathname: files.stalePathname,
    })
    .from(files)
    .where(lte(files.staleUntil, now))
    .limit(Math.min(Math.max(limit, 1), STALE_UPLOAD_LIMIT));

  const removed = await Promise.all(
    candidates.map(async ({ id, pathname }) => {
      if (!pathname || CANONICAL_PATH.test(pathname)) {
        return 0;
      }
      // Each candidate is independent, but its reference check, Blob delete and
      // metadata clear stay ordered so a failed delete remains retryable.
      const [reference] = await db()
        .select({ id: files.id })
        .from(files)
        .where(
          or(
            and(eq(files.pathname, pathname), ne(files.id, id)),
            and(eq(files.stalePathname, pathname), ne(files.id, id))
          )
        )
        .limit(1);
      if (reference) {
        return 0;
      }
      try {
        await del(pathname);
      } catch {
        return 0;
      }
      const [cleared] = await db()
        .update(files)
        .set({ stalePathname: null, staleUntil: null })
        .where(and(eq(files.id, id), eq(files.stalePathname, pathname)))
        .returning({ id: files.id });
      return cleared ? 1 : 0;
    })
  );
  return removed.reduce<number>((total, count) => total + count, 0);
}

export async function linkFileProvenance(
  botId: string,
  fileId: string,
  provenance: FileProvenance
): Promise<boolean> {
  const where = and(eq(files.id, fileId), eq(files.botId, botId));
  const values = {
    messageId: provenance.messageId ?? undefined,
    sessionId: provenance.sessionId ?? undefined,
    turnId: provenance.turnId ?? undefined,
  };
  // A bot may reserve a file before its session is available. In that case the
  // call still needs to verify the scoped row, but Drizzle rejects an UPDATE
  // whose values are all undefined.
  if (Object.values(values).every((value) => value === undefined)) {
    const [row] = await db().select({ id: files.id }).from(files).where(where);
    return Boolean(row);
  }
  const [row] = await db()
    .update(files)
    .set(values)
    .where(where)
    .returning({ id: files.id });
  return Boolean(row);
}

/**
 * Collect one unreferenced shared object. The candidate list is only a hint: the reference check that
 * decides runs again here, inside a short transaction that holds the digest lock promotion takes, so a
 * reference attached after the candidate was listed keeps the object. A Blob error rolls the row back
 * and leaves the object for the next sweep.
 */
async function collectOrphanedObject(candidate: {
  id: string;
  sha256: string;
}): Promise<boolean> {
  return await db().transaction(async (tx) => {
    // Lock order is digest first, then row. Promotion follows the same order.
    await lockDigest(tx, candidate.sha256);
    const [object] = await tx
      .select({ pathname: libraryObjects.pathname })
      .from(libraryObjects)
      .where(eq(libraryObjects.id, candidate.id))
      .for("update");
    if (!object) {
      return false;
    }
    const [reference] = await tx
      .select({ id: files.id })
      .from(files)
      .where(
        or(
          eq(files.objectId, candidate.id),
          eq(files.pathname, object.pathname),
          eq(files.stalePathname, object.pathname)
        )
      )
      .limit(1);
    if (reference) {
      return false;
    }
    // Physical deletion and the final reference check share the digest lock with promotion. If the
    // commit fails after this, the row survives without bytes and the next promotion of the same
    // digest copies the verified upload back before attaching (ensureObjectStorage).
    await del(object.pathname);
    const [deleted] = await tx
      .delete(libraryObjects)
      .where(eq(libraryObjects.id, candidate.id))
      .returning({ id: libraryObjects.id });
    return Boolean(deleted);
  });
}

/**
 * Garbage-collect shared objects that no file references, in a bounded batch. Without `objectIds` it
 * scans every orphan (the library verification cron), so an object whose last reference disappeared
 * after a caller captured its ids, or in a delete that never reached this call, is still collected.
 * Running it twice is a no-op for objects already gone or referenced again.
 */
export async function deleteOrphanedLibraryObjects(
  objectIds?: string[],
  limit = ORPHAN_OBJECT_LIMIT
) {
  const filters = [isNull(files.id)];
  if (objectIds) {
    if (objectIds.length === 0) {
      return 0;
    }
    filters.push(inArray(libraryObjects.id, objectIds));
  }
  const orphaned = await db()
    .select({ id: libraryObjects.id, sha256: libraryObjects.sha256 })
    .from(libraryObjects)
    .leftJoin(files, eq(files.objectId, libraryObjects.id))
    .where(and(...filters))
    .limit(Math.min(Math.max(limit, 1), ORPHAN_OBJECT_LIMIT));
  let removed = 0;
  for (const candidate of orphaned) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Each candidate holds its digest lock in its own short transaction.
      if (await collectOrphanedObject(candidate)) {
        removed += 1;
      }
    } catch {
      // A Blob or database failure keeps this object for the next sweep; the batch continues.
    }
  }
  return removed;
}

/** A narrow object projection for tests and cleanup callers. */
export function objectIdentity(row: LibraryObjectRow) {
  return {
    id: row.id,
    pathname: row.pathname,
    sha256: row.sha256,
    status: row.status,
  };
}

export function canonicalPathForHash(sha256: string) {
  return objectPathForSha256(sha256);
}
