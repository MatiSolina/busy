import { and, eq, ne, sql } from "drizzle-orm";
import { sleep } from "workflow";
import { getBot } from "../lib/bots/service";
import type { ClientRow } from "../lib/chat/items";
import { persistedEvents } from "../lib/chat/send";
import { deliverySettled } from "../lib/chat/status";
import { syncBotSession, syncConsultation } from "../lib/chat/store";
import { consultations, db, events } from "../lib/db";

/** Where a delivery was admitted, from the stored stream (delivery ids are unique per bot). */
async function admissionOf(botId: string, deliveryId: string) {
  const [admitted] = await db()
    .select({ line: events.line, sessionId: events.sessionId })
    .from(events)
    .where(
      and(
        eq(events.botId, botId),
        eq(events.type, "delivery.admitted"),
        sql`${events.data}->'data'->>'deliveryId' = ${deliveryId}`
      )
    )
    .limit(1);
  return admitted ?? null;
}

/**
 * Copies what the bot did so far into Postgres; true once this message's turn is over. It reads
 * the session that admitted the delivery, even after the bot moved to another one (N-04).
 */
async function syncTurnStep(
  slug: string,
  deliveryId: string,
  admittedIn?: string
): Promise<boolean> {
  "use step";
  const bot = await getBot(slug);
  if (!bot) {
    return true;
  }
  let sessionId = admittedIn;
  if (!sessionId) {
    // A workflow started before the session was captured: only stored evidence names its session.
    sessionId = (await admissionOf(bot.id, deliveryId))?.sessionId;
    if (!sessionId) {
      if (!bot.sessionId) {
        return false;
      }
      // Look for it in the current session, but never adopt that session without the admission.
      await syncBotSession(bot, bot.sessionId);
      sessionId = (await admissionOf(bot.id, deliveryId))?.sessionId;
      if (!sessionId) {
        return false;
      }
    }
  }
  await syncBotSession(bot, sessionId);
  const [admitted] = await db()
    .select({ line: events.line })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        eq(events.type, "delivery.admitted"),
        sql`${events.data}->'data'->>'deliveryId' = ${deliveryId}`
      )
    )
    .limit(1);
  if (!admitted) {
    return false;
  }
  const rows = await persistedEvents(sessionId, admitted.line - 1);
  return deliverySettled(rows as ClientRow[], deliveryId);
}

/** The private threads this bot opened with other bots during the turn. */
async function syncConsultationsStep(slug: string): Promise<void> {
  "use step";
  const bot = await getBot(slug);
  if (!bot) {
    return;
  }
  const open = await db()
    .select()
    .from(consultations)
    .where(
      and(
        eq(consultations.fromBotId, bot.id),
        ne(consultations.status, "synced")
      )
    );
  await Promise.allSettled(open.map(syncConsultation));
}

/**
 * Follows one message's turn until it settles, so nothing depends on the app being open (spec 4.3).
 * v2 arguments add the session that admitted the delivery; runs started with v1's
 * `(slug, deliveryId)` find it from the stored `delivery.admitted` instead of guessing.
 */
export async function syncTurnWorkflow(
  slug: string,
  deliveryId: string,
  sessionId?: string
) {
  "use workflow";
  // ponytail: polls every 15 s for up to 2 h; the hourly cron picks up anything longer.
  for (let i = 0; i < 480; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: This durable workflow polls sequentially with a fixed backoff.
    if (await syncTurnStep(slug, deliveryId, sessionId)) {
      break;
    }
    await sleep("15s");
  }
  await syncConsultationsStep(slug);
}
