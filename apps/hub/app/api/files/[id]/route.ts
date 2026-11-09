import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, files } from "@/lib/db";
import { readUrl } from "@/lib/files";

// Always a fresh signed URL, so old file cards keep working (spec 4.4).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = z.uuid().safeParse((await params).id);
  if (!id.success) {
    return new Response("not found", { status: 404 });
  }
  const [row] = await db().select().from(files).where(eq(files.id, id.data));
  if (row?.status !== "ready") {
    return new Response("not found", { status: 404 });
  }
  const url = new URL(await readUrl(row.pathname));
  if (!new URL(req.url).searchParams.has("download")) {
    return Response.redirect(url, 302);
  }
  url.searchParams.set("download", "1");
  // Blob names the download after the path, so a content-addressed library path loses the name and
  // extension; those stream through here with the real name.
  if (row.pathname.endsWith(row.name)) {
    return Response.redirect(url, 302);
  }
  const blob = await fetch(url);
  if (!(blob.ok && blob.body)) {
    return new Response("unavailable", { status: 502 });
  }
  return new Response(blob.body, {
    headers: {
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "content-type": blob.headers.get("content-type") ?? row.contentType,
    },
  });
}
