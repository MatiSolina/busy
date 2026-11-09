import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { db, events } from "../db";
import { FAST_INDEX_BASE } from "./fast-path";
import { projectTurn, type TurnFact, type TurnProjection } from "./status";

const ANCHORS = ["turn.started", "session.ended"];

/**
 * The open turn of a stored session (H-33), read from the synced facts: the newest turn's facts
 * plus the deliveries eve admitted and hasn't settled. Only reads; it never writes a fact.
 */
export async function sessionTurn(
  sessionId: string,
  now = Date.now()
): Promise<TurnProjection> {
  const q = db();
  const [anchor] = await q
    .select({ index: events.index, line: events.line })
    .from(events)
    .where(and(eq(events.sessionId, sessionId), inArray(events.type, ANCHORS)))
    .orderBy(desc(events.line), desc(events.index))
    .limit(1);
  const [rows, [pending]] = await Promise.all([
    anchor
      ? q
          .select({
            at: events.at,
            index: events.index,
            line: events.line,
            turnId: sql<
              string | null
            >`coalesce(${events.data}->'data'->>'turnId', ${events.data}->'scope'->>'turnId')`,
            type: events.type,
          })
          .from(events)
          .where(
            and(eq(events.sessionId, sessionId), gte(events.line, anchor.line))
          )
          .orderBy(events.line, events.index)
      : Promise.resolve([]),
    // An admitted message without its settle may not have a turn yet (eve's own rows only: the
    // hub's fast acks reuse delivery ids above FAST_INDEX_BASE).
    q
      .select({ count: sql<number>`count(*)::int` })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          eq(events.type, "delivery.admitted"),
          lt(events.index, FAST_INDEX_BASE),
          sql`not exists (
            select 1 from ${events} settled
            where settled.session_id = ${events.sessionId}
              and settled.type = 'delivery.settled'
              and settled.data->'data'->>'deliveryId' = ${events.data}->'data'->>'deliveryId'
          )`
        )
      ),
  ]);
  const facts: TurnFact[] = rows
    .filter(
      (r) =>
        anchor &&
        (r.line > anchor.line ||
          (r.line === anchor.line && r.index >= anchor.index))
    )
    .map((r) => ({
      at: r.at,
      data: { scope: r.turnId === null ? {} : { turnId: r.turnId } },
      type: r.type,
    }));
  const projection = projectTurn(facts, now);
  return projection.state === "ended"
    ? projection
    : { ...projection, pendingDeliveries: pending?.count ?? 0 };
}

/** The bot may still need its computer: an open turn, or a message no turn took yet. */
export const sessionBusy = (p: TurnProjection): boolean =>
  p.state === "running" ||
  p.state === "awaiting_input" ||
  p.state === "unknown" ||
  (p.state === "idle" && p.pendingDeliveries > 0);
