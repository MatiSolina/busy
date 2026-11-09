import { and, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { syncBot, syncConsultation } from "@/lib/chat/store";
import { bots, consultations, db } from "@/lib/db";

// Hourly safety net: each turn is synced by syncTurnWorkflow; this catches whatever it missed (spec 4.3).
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const ready = await db()
    .select()
    .from(bots)
    .where(
      and(
        eq(bots.status, "ready"),
        isNotNull(bots.sessionId),
        isNull(bots.deletionState)
      )
    );
  const open = await db()
    .select()
    .from(consultations)
    .where(ne(consultations.status, "synced"));
  const results = await Promise.allSettled([
    ...ready.map(syncBot),
    ...open.map(syncConsultation),
  ]);
  // Only threads already done before this run are final: one finishing now may not be fully read yet.
  // One that failed to read stays done, so the next run reads it again.
  const finished = open
    .filter(
      (c, i) =>
        c.status === "done" && results[ready.length + i]?.status === "fulfilled"
    )
    .map((c) => c.id);
  if (finished.length) {
    await db()
      .update(consultations)
      .set({ status: "synced" })
      .where(inArray(consultations.id, finished));
  }
  const failed = results.filter((r) => r.status === "rejected").length;
  return Response.json({
    bots: ready.length,
    consultations: open.length,
    failed,
  });
}

export const maxDuration = 300;
