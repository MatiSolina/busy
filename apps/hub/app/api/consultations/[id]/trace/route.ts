import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import {
  buildChatTraceTimeline,
  type ChatTraceMessage,
} from "@/lib/chat/observability";
import type { TraceSelectRow } from "@/lib/chat/trace-query";
import { asTraceEvent, traceSelect } from "@/lib/chat/trace-query";
import { bots, consultations, db, events } from "@/lib/db";

const MAX_SCAN_ROWS = 1000;
const TRACE_EVENT_TYPES = [
  "call.requested",
  "call.settled",
  "call.started",
  "child.opened",
  "content.completed",
  "delivery.admitted",
  "delivery.consumed",
  "delivery.settled",
  "interaction.opened",
  "interaction.settled",
  "model.requested",
  "model.retried",
  "model.settled",
  "model.started",
  "response.admitted",
  "response.settled",
  "response.submitted",
  "session.started",
  "turn.paused",
  "turn.settled",
  "turn.started",
  "usage.recorded",
] as const;
const SAFE_OUTCOMES = new Set([
  "cancelled",
  "completed",
  "failed",
  "interrupted",
  "pending",
  "rejected",
  "skipped",
  "success",
  "timeout",
  "unknown",
]);

type TraceRow = TraceSelectRow & { childSessionId: string | null };

const consultationTraceSelect = {
  ...traceSelect,
  callId: sql<string | null>`coalesce(
    ${events.data}->'data'->>'callId',
    ${events.data}->'data'->'owner'->>'callId'
  )`.as("call_id"),
  childSessionId: sql<string | null>`${events.data}->'data'->>'sessionId'`.as(
    "child_session_id"
  ),
};

function noStoreHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store",
    "Referrer-Policy": "no-referrer",
  };
}

async function authenticated(): Promise<boolean> {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return true;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return false;
  }
  return Boolean(
    await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret)
  );
}

function isoAt(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function eventWindow(rows: TraceRow[], scanTruncated: boolean) {
  return {
    eventCounts: Object.fromEntries(
      rows.reduce((counts, row) => {
        counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
        return counts;
      }, new Map<string, number>())
    ),
    firstLine: rows[0]?.line ?? null,
    lastLine: rows.at(-1)?.line ?? null,
    observedRows: rows.length,
    scanTruncated,
  };
}

function childSummary(
  consultation: typeof consultations.$inferSelect,
  fromSlug: string,
  rows: TraceRow[],
  scanTruncated: boolean
) {
  const admittedDeliveries = rows
    .filter((row) => row.type === "delivery.admitted" && row.deliveryId)
    .map((row) => row.deliveryId as string);
  const deliveryIds = [...new Set(admittedDeliveries)];
  const deliveryId = deliveryIds.length === 1 ? deliveryIds[0] : null;
  const message: ChatTraceMessage = {
    botSlug: fromSlug,
    createdAt: consultation.createdAt,
    deliveryId,
    id: consultation.id,
    status: consultation.status,
  };
  const timeline = buildChatTraceTimeline(
    message,
    consultation.childSessionId,
    rows.map(asTraceEvent),
    scanTruncated
  );
  return {
    complete: timeline.complete,
    correlation: timeline.correlation,
    delivery: timeline.stages.delivery,
    eventWindow: timeline.eventWindow,
    missing: [
      ...timeline.missing,
      ...(deliveryIds.length > 1 ? ["delivery_id_ambiguous"] : []),
    ],
    modelAttempts: timeline.stages.modelAttempts,
    turn: timeline.stages.turn,
    usage: timeline.usage,
  };
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await authenticated())) {
    return Response.json(
      { error: "unauthorized" },
      { headers: noStoreHeaders(), status: 401 }
    );
  }
  const parsedId = z.uuid().safeParse((await params).id);
  if (!parsedId.success) {
    return Response.json(
      { error: "invalid_id" },
      { headers: noStoreHeaders(), status: 400 }
    );
  }
  const [consultation] = await db()
    .select()
    .from(consultations)
    .where(eq(consultations.id, parsedId.data))
    .limit(1);
  if (!consultation) {
    return Response.json(
      { error: "not_found" },
      { headers: noStoreHeaders(), status: 404 }
    );
  }
  const people = await db()
    .select({ id: bots.id, slug: bots.slug })
    .from(bots)
    .where(
      inArray(bots.id, [
        consultation.fromBotId,
        ...(consultation.toBotId ? [consultation.toBotId] : []),
      ])
    );
  const from = people.find((bot) => bot.id === consultation.fromBotId);
  const to = people.find((bot) => bot.id === consultation.toBotId);
  if (!(from && consultation.childSessionId)) {
    return Response.json(
      { error: "not_found" },
      { headers: noStoreHeaders(), status: 404 }
    );
  }

  const eventTypes = inArray(events.type, [...TRACE_EVENT_TYPES]);
  const parentCallTypes = inArray(events.type, [
    "call.requested",
    "call.started",
    "call.settled",
  ]);
  const parentRows = await db()
    .select(consultationTraceSelect)
    .from(events)
    .where(
      and(
        eq(events.botId, consultation.fromBotId),
        eq(events.sessionId, consultation.parentSessionId),
        or(
          and(
            eq(events.type, "child.opened"),
            sql`${events.data}->'data'->'owner'->>'callId' = ${consultation.callId}`,
            sql`${events.data}->'data'->>'sessionId' = ${consultation.childSessionId}`
          ),
          and(
            parentCallTypes,
            sql`${events.data}->'data'->>'callId' = ${consultation.callId}`
          )
        )
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(MAX_SCAN_ROWS + 1);
  const childRows = await db()
    .select(consultationTraceSelect)
    .from(events)
    .where(
      and(
        eq(events.botId, consultation.fromBotId),
        eq(events.sessionId, consultation.childSessionId),
        eventTypes
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(MAX_SCAN_ROWS + 1);
  const parentTruncated = parentRows.length > MAX_SCAN_ROWS;
  const childTruncated = childRows.length > MAX_SCAN_ROWS;
  const parent = parentRows.slice(0, MAX_SCAN_ROWS);
  const child = childRows.slice(0, MAX_SCAN_ROWS);
  const parentChildOpened = parent.find(
    (row) =>
      row.type === "child.opened" &&
      row.callId === consultation.callId &&
      row.childSessionId === consultation.childSessionId
  );
  const parentSettled = parent
    .filter(
      (row) =>
        row.type === "call.settled" &&
        row.callId === consultation.callId &&
        Boolean(
          parentChildOpened &&
            (row.line > parentChildOpened.line ||
              (row.line === parentChildOpened.line &&
                row.index > parentChildOpened.index))
        )
    )
    .at(-1);
  const childTrace = childSummary(
    consultation,
    from.slug,
    child,
    childTruncated
  );
  const missing = [
    ...(parentChildOpened ? [] : ["parent.child.opened"]),
    ...(parentSettled ? [] : ["parent.call.settled"]),
    ...childTrace.missing.map((item) => `child.${item}`),
  ];
  if (parentTruncated) {
    missing.push("parent.scan");
  }
  if (childTruncated) {
    missing.push("child.scan");
  }

  return Response.json(
    {
      child: childTrace,
      complete: missing.length === 0 && childTrace.complete,
      consultation: {
        callId: consultation.callId,
        childSessionId: consultation.childSessionId,
        fromBotId: consultation.fromBotId,
        fromBotSlug: from.slug,
        id: consultation.id,
        parentSessionId: consultation.parentSessionId,
        status: consultation.status,
        toBotId: consultation.toBotId,
        toBotSlug: to?.slug ?? null,
      },
      eventWindow: {
        child: eventWindow(child, childTruncated),
        parent: eventWindow(parent, parentTruncated),
      },
      missing,
      parent: {
        call: {
          outcome:
            parentSettled?.outcome && SAFE_OUTCOMES.has(parentSettled.outcome)
              ? parentSettled.outcome
              : null,
          settledAt: isoAt(parentSettled?.at),
        },
        childOpenedAt: isoAt(parentChildOpened?.at),
      },
    },
    { headers: noStoreHeaders() }
  );
}

export const maxDuration = 60;
