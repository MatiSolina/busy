import { z } from "zod";
import { consultationThread } from "@/lib/chat/initial";

// The private "A ⇄ B" thread, read-only (spec 2).
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = z.uuid().safeParse((await params).id);
  const thread = id.success ? await consultationThread(id.data) : null;
  return thread
    ? Response.json(thread)
    : new Response("not found", { status: 404 });
}

export const maxDuration = 60;
