import { and, eq, gte, lt, sql } from "drizzle-orm";
import { cursors, db, events, fastSlotReservations } from "../db";
import { FAST_INDEX_BASE, type FastSlot } from "./fast-path";

/** Indexes one exchange may write: user, start, reply, settle (an ack uses the first three). */
const SLOT_WIDTH = 4;
/** Longer than the messages route can run (60 s): only a crashed request leaves one this old. */
const RESERVATION_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 8;

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/** A reserved slot was reclaimed or released before its events were stored. */
export class FastSlotLost extends Error {
  constructor() {
    super("fast_slot_lost");
    this.name = "FastSlotLost";
  }
}

async function nextIndex(sessionId: string, line: number): Promise<number> {
  const q = db();
  const [[stored], [reserved]] = await Promise.all([
    q
      .select({ index: sql<number | null>`max(${events.index})` })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          eq(events.line, line),
          gte(events.index, FAST_INDEX_BASE)
        )
      ),
    q
      .select({
        index: sql<number | null>`max(${fastSlotReservations.slotIndex})`,
      })
      .from(fastSlotReservations)
      .where(
        and(
          eq(fastSlotReservations.sessionId, sessionId),
          eq(fastSlotReservations.line, line)
        )
      ),
  ]);
  return Math.max(
    FAST_INDEX_BASE,
    stored?.index === null || stored?.index === undefined
      ? FAST_INDEX_BASE
      : Number(stored.index) + 1,
    reserved?.index === null || reserved?.index === undefined
      ? FAST_INDEX_BASE
      : Number(reserved.index) + SLOT_WIDTH
  );
}

/**
 * Claims the next free slot on eve's last line before the model runs. Two concurrent requests may
 * compute the same index; the primary key lets exactly one insert it and the other recomputes past
 * it. No lock is held afterwards, so inference stays concurrent.
 */
export async function reserveFastSlot(
  sessionId: string,
  messageId: string
): Promise<FastSlot> {
  const q = db();
  const [cursor] = await q
    .select({ nextLine: cursors.nextLine })
    .from(cursors)
    .where(eq(cursors.sessionId, sessionId));
  const line = (cursor?.nextLine ?? 0) - 1;
  // A crashed request's reservation: its holder can no longer store (it must consume it first).
  await q
    .delete(fastSlotReservations)
    .where(
      and(
        eq(fastSlotReservations.sessionId, sessionId),
        lt(fastSlotReservations.expiresAt, new Date())
      )
    );
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each attempt depends on the previous conflict.
    const index = await nextIndex(sessionId, line);
    const [won] = await q
      .insert(fastSlotReservations)
      .values({
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        line,
        messageId,
        sessionId,
        slotIndex: index,
      })
      .onConflictDoNothing()
      .returning({ index: fastSlotReservations.slotIndex });
    if (won) {
      return { index: won.index, line };
    }
  }
  throw new Error("fast_slot_contended");
}

const owned = (sessionId: string, slot: FastSlot, messageId: string) =>
  and(
    eq(fastSlotReservations.sessionId, sessionId),
    eq(fastSlotReservations.line, slot.line),
    eq(fastSlotReservations.slotIndex, slot.index),
    eq(fastSlotReservations.messageId, messageId)
  );

/** Inside the transaction that stores the events: the reservation must still be ours. */
export async function consumeFastSlot(
  tx: Tx,
  sessionId: string,
  slot: FastSlot,
  messageId: string
) {
  const [mine] = await tx
    .delete(fastSlotReservations)
    .where(owned(sessionId, slot, messageId))
    .returning({ index: fastSlotReservations.slotIndex });
  if (!mine) {
    throw new FastSlotLost();
  }
}

/**
 * Escalated or failed: nothing will be stored at this slot. Best effort: a lost delete only leaves
 * a reservation that expires; it never blocks or overwrites another exchange.
 */
export async function releaseFastSlot(
  sessionId: string,
  slot: FastSlot,
  messageId: string
) {
  try {
    await db()
      .delete(fastSlotReservations)
      .where(owned(sessionId, slot, messageId));
  } catch {
    // Expires on its own.
  }
}
