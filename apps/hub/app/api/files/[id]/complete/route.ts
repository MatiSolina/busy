import { eq } from "drizzle-orm";
import { start } from "workflow/api";
import { z } from "zod";
import { db, files } from "@/lib/db";
import { completeFile } from "@/lib/files";
import { verifyFileWorkflow } from "@/workflows/verify-file";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) {
    return new Response("not found", { status: 404 });
  }
  const [row] = await db()
    .select({ botId: files.botId })
    .from(files)
    .where(eq(files.id, id.data));
  if (!row) {
    return new Response("not found", { status: 404 });
  }
  if (!(await completeFile(row.botId, id.data))) {
    return new Response("not found", { status: 404 });
  }
  await start(verifyFileWorkflow, [row.botId, id.data]).catch(() => {
    // The library verification cron retries ready files whose object_id is null.
  });
  return Response.json({ ok: true, status: "ready", verification: "queued" });
}
