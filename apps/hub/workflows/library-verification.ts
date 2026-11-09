import { and, eq, isNull } from "drizzle-orm";
import { db, files } from "../lib/db";
import { expirePendingFiles } from "../lib/files";
import {
  deleteExpiredStaleUploads,
  deleteOrphanedLibraryObjects,
  promoteVerifiedFile,
} from "../lib/library-objects";

async function pendingFilesStep(limit: number) {
  "use step";
  return await db()
    .select({ botId: files.botId, id: files.id })
    .from(files)
    .where(and(eq(files.status, "ready"), isNull(files.objectId)))
    .limit(limit);
}

async function promoteFileStep(botId: string, fileId: string) {
  "use step";
  await promoteVerifiedFile(botId, fileId);
}

async function cleanupStaleUploadsStep() {
  "use step";
  return await deleteExpiredStaleUploads();
}

async function expirePendingFilesStep(limit: number) {
  "use step";
  return await expirePendingFiles(limit);
}

async function collectOrphanedObjectsStep(limit: number) {
  "use step";
  // Every unreferenced object, not a list captured by a delete: a promotion that raced a bot deletion,
  // or a deletion that stopped before its own collection, is reclaimed here.
  return await deleteOrphanedLibraryObjects(undefined, limit);
}

/**
 * Recovers ready references whose post-upload hash workflow was interrupted, removes promoted uploads
 * whose signed URLs have expired, expires upload reservations past their deadline and
 * garbage-collects shared objects that lost their last reference.
 */
export async function libraryVerificationWorkflow(limit = 16) {
  "use workflow";
  const bounded = Math.min(Math.max(limit, 1), 64);
  const pending = await pendingFilesStep(bounded);
  await Promise.allSettled(
    pending.map(({ botId, id }) => promoteFileStep(botId, id))
  );
  await cleanupStaleUploadsStep();
  await expirePendingFilesStep(bounded);
  await collectOrphanedObjectsStep(bounded);
}
