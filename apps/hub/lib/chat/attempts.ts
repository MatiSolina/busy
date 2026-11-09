import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import {
  type BotRow,
  bots,
  db,
  messageDeliveryAttempts,
  messages,
} from "../db";
import { consumptionIn } from "./consumption";
import { failGoneAttempt, resendPinned } from "./send";

/**
 * Message reconciliation (H-21) on top of the delivery identity of #195
 * (`message_delivery_attempts`, lib/chat/send.ts, docs/session-recovery.md). That row is the one
 * source of truth for which session a message went to and whether eve accepted it; `messages` is
 * its projection (status, delivery_id, session_id) plus this sweeper's schedule (check_after,
 * checks) and fixed failure reason.
 *
 * A send left `unknown` (lost acknowledgement) or `sending` past its lease (the process died) is
 * otherwise only resolved when the user retries. The sweeper looks for evidence first: a
 * consumption in the pinned session accepts it. A recent text-only message is re-sent with the
 * persisted envelope to that same session and key (eve returns the original receipt or admits it
 * once). A session that is gone and whose readable stream never ran the message fails it with a
 * fixed reason; the user's retry then moves it to the current session. Anything still unknown backs
 * off; after MAX_CHECKS it is marked `unconfirmed` and left for the user's retry. Never by age.
 */

/** A pending attempt older than this is not re-sent: it would arrive too late. */
const RESEND_WINDOW_MS = 30 * 60_000;
/** Leaves the request that made the attempt time to finish (route maxDuration 60 s). */
const SETTLE_MS = 2 * 60_000;
const MAX_CHECKS = 6;

const later = (ms: number) => sql`now() + make_interval(secs => ${ms / 1000})`;

/** eve's receipt, projected on the message: promotes pending or failed, never rewrites accepted. */
export async function acceptMessage(
  id: string,
  deliveryId: string,
  sessionId: string | null
): Promise<boolean> {
  const rows = await db()
    .update(messages)
    .set({
      checkAfter: null,
      deliveryId,
      failure: null,
      ...(sessionId ? { sessionId } : {}),
      status: "accepted",
    })
    .where(
      and(
        eq(messages.id, id),
        ne(messages.status, "accepted"),
        isNull(messages.deliveryId)
      )
    )
    .returning({ id: messages.id });
  return rows.length > 0;
}

export interface ReconcileDeps {
  consumption: typeof consumptionIn;
  failGone: typeof failGoneAttempt;
  resend: typeof resendPinned;
}

const reconcileDefaults: ReconcileDeps = {
  consumption: consumptionIn,
  failGone: failGoneAttempt,
  resend: resendPinned,
};

export interface ReconcileReport {
  accepted: number;
  /** Still unknown: checked again later. */
  ambiguous: number;
  failed: number;
  /** Claimed by another run first. */
  skipped: number;
  unconfirmed: number;
}

export async function reconcileMessages(
  limit = 25,
  deps: ReconcileDeps = reconcileDefaults
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    accepted: 0,
    ambiguous: 0,
    failed: 0,
    skipped: 0,
    unconfirmed: 0,
  };
  const due = await db()
    .select({
      bot: bots,
      checks: messages.checks,
      createdAt: messages.createdAt,
      fileIds: messages.fileIds,
      id: messages.id,
      sessionId: messageDeliveryAttempts.sessionId,
      text: messages.text,
    })
    .from(messages)
    .innerJoin(
      messageDeliveryAttempts,
      eq(messageDeliveryAttempts.messageId, messages.id)
    )
    .innerJoin(bots, eq(bots.id, messages.botId))
    .where(
      and(
        ne(messages.status, "accepted"),
        sql`${messageDeliveryAttempts.sessionId} is not null`,
        or(
          eq(messageDeliveryAttempts.state, "unknown"),
          and(
            eq(messageDeliveryAttempts.state, "sending"),
            lt(messageDeliveryAttempts.postingUntil, sql`now()`)
          )
        ),
        lt(messageDeliveryAttempts.updatedAt, later(-SETTLE_MS)),
        or(isNull(messages.checkAfter), lt(messages.checkAfter, sql`now()`))
      )
    )
    .orderBy(asc(messageDeliveryAttempts.updatedAt))
    .limit(limit);
  for (const row of due) {
    // biome-ignore lint/performance/noAwaitInLoops: attempts are reconciled one by one, each with its own claim.
    report[await reconcileOne(row, deps)] += 1;
  }
  return report;
}

interface Due {
  bot: BotRow;
  checks: number;
  createdAt: Date;
  fileIds: string[];
  id: string;
  sessionId: string | null;
  text: string;
}

async function reconcileOne(
  row: Due,
  deps: ReconcileDeps
): Promise<keyof ReconcileReport> {
  const sessionId = row.sessionId as string;
  const backoffMs = Math.min(2 ** row.checks, 60) * 60_000;
  const [claim] = await db()
    .update(messages)
    .set({ checkAfter: later(backoffMs), checks: row.checks + 1 })
    .where(
      and(
        eq(messages.id, row.id),
        eq(messages.checks, row.checks),
        ne(messages.status, "accepted")
      )
    )
    .returning({ id: messages.id });
  if (!claim) {
    // Another sweeper (or the user's retry) got there first.
    return "skipped";
  }
  const evidence = await deps.consumption(row.bot, sessionId, {
    fileCount: row.fileIds.length,
    text: row.text,
  });
  if (evidence && evidence !== "unknown") {
    await db()
      .update(messageDeliveryAttempts)
      .set({
        deliveryId: evidence.deliveryId,
        postingUntil: null,
        state: "accepted",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(messageDeliveryAttempts.messageId, row.id),
          eq(messageDeliveryAttempts.sessionId, sessionId),
          ne(messageDeliveryAttempts.state, "accepted")
        )
      );
    await acceptMessage(row.id, evidence.deliveryId, sessionId);
    return "accepted";
  }
  const recent = Date.now() - row.createdAt.getTime() < RESEND_WINDOW_MS;
  // Files are not re-signed here: such a message waits for the user's retry.
  if (recent && row.fileIds.length === 0) {
    const sent = await deps.resend(row.bot, row.id);
    if (sent.kind === "accepted") {
      await acceptMessage(row.id, sent.deliveryId, sessionId);
      return "accepted";
    }
    if (
      sent.kind === "gone" &&
      evidence === null &&
      (await deps.failGone(row.bot.id, row.id))
    ) {
      await db()
        .update(messages)
        .set({ checkAfter: null, failure: "session_gone", status: "failed" })
        .where(
          and(
            eq(messages.id, row.id),
            ne(messages.status, "accepted"),
            isNull(messages.deliveryId)
          )
        );
      return "failed";
    }
  }
  if (row.checks + 1 >= MAX_CHECKS) {
    await db()
      .update(messages)
      .set({ checkAfter: sql`'infinity'`, failure: "unconfirmed" })
      .where(and(eq(messages.id, row.id), ne(messages.status, "accepted")));
    return "unconfirmed";
  }
  return "ambiguous";
}
