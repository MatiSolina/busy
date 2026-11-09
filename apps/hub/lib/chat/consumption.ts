import { and, eq } from "drizzle-orm";
import { type BotRow, db, events } from "../db";
import { syncBotSession } from "./store";

const SEEDED_HISTORY = /^<prior_history>[\s\S]*?<\/prior_history>\n*/u;
const STREAM_EXPIRED = /stream failed: 410\b/u;

/**
 * Whether a message was consumed in `sessionId`, from its stored stream (H-21, H-36).
 * delivery.admitted carries no idempotency key, so consumption is matched on what the turn
 * received: the message's text (after any seeded history), or for a files-only message the same
 * number of files. Admitted-but-never-consumed in a session that is gone ran no turn.
 * "unknown": the stream can't be read now.
 */
export async function consumptionIn(
  bot: BotRow,
  sessionId: string,
  message: { fileCount: number; text: string },
  sync: (bot: BotRow, sessionId: string) => Promise<void> = syncBotSession
): Promise<{ deliveryId: string } | null | "unknown"> {
  try {
    await sync(bot, sessionId);
  } catch (error) {
    // An expired stream (410) is gone for good: what was stored before is all the evidence left.
    if (!(error instanceof Error && STREAM_EXPIRED.test(error.message))) {
      return "unknown";
    }
  }
  const consumed = await db()
    .select({ data: events.data })
    .from(events)
    .where(
      and(eq(events.sessionId, sessionId), eq(events.type, "delivery.consumed"))
    );
  const text = message.text.trim();
  for (const { data } of consumed) {
    const fact = (data as { data?: Record<string, unknown> }).data ?? {};
    const parts =
      (fact.parts as { kind?: string; text?: string }[] | undefined) ?? [];
    const said = parts
      .filter((p) => p.kind === "text")
      .map((p) => p.text ?? "")
      .join("\n")
      .replace(SEEDED_HISTORY, "")
      .trim();
    const files = parts.filter((p) => p.kind === "file").length;
    const same = text
      ? said === text
      : !said && files === message.fileCount && files > 0;
    if (same && typeof fact.deliveryId === "string") {
      return { deliveryId: fact.deliveryId };
    }
  }
  return null;
}
