import { eq } from "drizzle-orm";
import { z } from "zod";
import { sanitizeAiFact } from "@/lib/chat/model-errors";
import {
  errorCodeOf,
  logChatObservation,
  requestIdOf,
} from "@/lib/chat/observability";
import { persistedEvents } from "@/lib/chat/send";
import { relay, sseResponse } from "@/lib/chat/sse";
import { botCall, cursorOf, saver } from "@/lib/chat/store";
import { bots, consultations, db } from "@/lib/db";
import { childStreamPath, readStreamAt } from "@/lib/eve/client";

/**
 * The private "A ⇄ B" thread live: stored lines after `?after=<line>`, then the child stream read
 * through the asking bot. An open thread is followed (the client reconnects every 5 minutes); a
 * finished one is read to its end, marked synced, and closed with `end`.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const id = z.uuid().safeParse((await params).id);
  const [c] = id.success
    ? await db()
        .select()
        .from(consultations)
        .where(eq(consultations.id, id.data))
    : [];
  if (!c?.childSessionId) {
    return new Response("not found", { status: 404 });
  }
  const child = c.childSessionId;
  const [from] = await db().select().from(bots).where(eq(bots.id, c.fromBotId));
  const [to] = c.toBotId
    ? await db().select().from(bots).where(eq(bots.id, c.toBotId))
    : [];
  const after = Number(new URL(req.url).searchParams.get("after") ?? -1);
  const requestId = requestIdOf(req);

  return sseResponse(req, async (send, closed, signal) => {
    const start = await cursorOf(child);
    for (const r of await persistedEvents(child, after)) {
      send(
        "fact",
        { ...r, data: sanitizeAiFact(r.data, to?.billing ?? null) },
        r.line
      );
    }
    if (from && c.status !== "synced") {
      const open = c.status === "open";
      const path = childStreamPath(c.parentSessionId, c.callId, child);
      const read = await relay(
        readStreamAt(botCall(from.slug), path, start, open, signal),
        saver(from, child, false),
        send,
        closed,
        to?.billing ?? null,
        {
          botSlug: from.slug,
          callId: c.callId,
          childSessionId: child,
          parentSessionId: c.parentSessionId,
          requestId,
          sessionId: child,
        }
      ).catch((error) => {
        logChatObservation("chat.stream", {
          botSlug: from.slug,
          callId: c.callId,
          childSessionId: child,
          errorCode: errorCodeOf(error),
          outcome: "failed",
          parentSessionId: c.parentSessionId,
          requestId,
          sessionId: child,
        });
        return false;
      });
      // An open thread ends here and the client reconnects. Only a thread done before this read is
      // final; a failed read leaves it for the next one (or the cron).
      if (open) {
        return;
      }
      if (read) {
        await db()
          .update(consultations)
          .set({ status: "synced" })
          .where(eq(consultations.id, c.id));
      }
    }
    send("end", {});
  });
}

export const maxDuration = 300;
