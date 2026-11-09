import { eq } from "drizzle-orm";
import { sleep } from "workflow";
import { bots, db } from "../lib/db";
import { deleteBotBlobs } from "../lib/files";

async function sweepStep(id: string, slug: string): Promise<void> {
  "use step";
  // Started before the delete: if that failed, the bot is still here and so are its files.
  const [alive] = await db()
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.id, id));
  if (!alive) {
    await deleteBotBlobs({ id, slug });
  }
}

/**
 * An upload signed before its bot was deleted can still land: sweep its folders again once that can't
 * happen. New deletions sweep inside deleteBotWorkflow; this stays registered for runs started before it.
 */
export async function sweepBotBlobsWorkflow(id: string, slug: string) {
  "use workflow";
  // Upload URLs live 15 minutes (lib/files.ts); the rest is room for a slow upload that began just before.
  await sleep("30m");
  await sweepStep(id, slug);
}
