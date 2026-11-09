import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type PublicBot, publicBot } from "../bots/service";
import { bots, consultations, db, events, messages } from "../db";
import { span } from "../trace";
import type { HistoryCursor, PastCursor, PastSession } from "./client-store";
import type { ClientRow, Fact } from "./items";
import { compactRow, prepareMarkdownRows } from "./markdown-rows";

export const ARCHIVED_HISTORY_ROWS = 400;
const INITIAL_HISTORY_ROWS = 120;
// One archived session per page keeps each session's fact frontier contiguous.
// Several short archived chats per request, loaded in parallel, so paging back keeps ahead of the reader.
const PAST_SESSION_PAGE_SIZE = 5;
const CURSOR_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const CURSOR_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u;

export interface ConsultRef {
  callId: string;
  id: string;
  peerName: string;
  peerSlug: string | null;
}

export async function consultationsOf(botId: string): Promise<ConsultRef[]> {
  return (await consultationsFor([botId])).get(botId) ?? [];
}

/** Without ids, every bot's consultations: the whole directory loads at once. */
async function consultationsFor(
  botIds?: string[]
): Promise<Map<string, ConsultRef[]>> {
  const rows = await db()
    .select({
      callId: consultations.callId,
      fromBotId: consultations.fromBotId,
      id: consultations.id,
      peerName: bots.name,
      peerSlug: bots.slug,
    })
    .from(consultations)
    .leftJoin(bots, eq(bots.id, consultations.toBotId))
    .where(
      inArray(
        consultations.fromBotId,
        botIds ?? db().select({ id: bots.id }).from(bots)
      )
    );
  const grouped = new Map<string, ConsultRef[]>();
  for (const { fromBotId, ...ref } of rows) {
    const list = grouped.get(fromBotId) ?? [];
    list.push({ ...ref, peerName: ref.peerName ?? "another bot" });
    grouped.set(fromBotId, list);
  }
  return grouped;
}

interface HistoryWindow {
  cursor: HistoryCursor | null;
  hasMore: boolean;
  resumeAfter: number;
}

interface CurrentRowsResult {
  history: Map<string, HistoryWindow>;
  resumeAfters: Map<string, number>;
  rows: Map<string, ClientRow[]>;
}

interface EventRow {
  data: unknown;
  index: number;
  line: number;
  type: string;
}

const rowFromEvent = (row: EventRow): ClientRow => ({
  data: row.data as Fact,
  index: row.index,
  line: row.line,
  type: row.type,
});

const rowKey = (row: ClientRow) => `${row.line}:${row.index}`;

function mergeHistoryRows(
  rows: readonly ClientRow[],
  context: readonly ClientRow[]
): ClientRow[] {
  const merged = new Map(rows.map((row) => [rowKey(row), row]));
  for (const row of context) {
    // Keep the page's version when a context query overlaps its frontier. In
    // particular, this preserves prepared metadata on a reloaded page.
    if (!merged.has(rowKey(row))) {
      merged.set(rowKey(row), row);
    }
  }
  return [...merged.values()].sort(
    (left, right) => left.line - right.line || left.index - right.index
  );
}

/** Open row for each lifecycle scope, without materializing completed history. */
async function openScopedRows(
  scope: SQL,
  terminalScope: SQL,
  startedType: string,
  terminalType: string,
  sessionId: string,
  resumeAfter: number,
  extra?: SQL
): Promise<(EventRow & { scopeId: string | null })[]> {
  const rows = await db()
    .selectDistinctOn([scope], {
      data: events.data,
      index: events.index,
      line: events.line,
      scopeId: scope,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        eq(events.type, startedType),
        isNotNull(scope),
        sql`${events.line} <= ${resumeAfter}`,
        extra,
        sql`NOT EXISTS (
          SELECT 1
          FROM events AS terminal
          WHERE terminal.session_id = ${events.sessionId}
            AND terminal.type = ${terminalType}
            AND terminal.line <= ${resumeAfter}
            AND ${terminalScope} = ${scope}
            AND (
              terminal.line > ${events.line}
              OR (
                terminal.line = ${events.line}
                AND terminal.index >= ${events.index}
              )
            )
        )`
      )
    )
    .orderBy(asc(scope), desc(events.line), desc(events.index));
  return rows.map((row) => ({
    ...row,
    scopeId: typeof row.scopeId === "string" ? row.scopeId : null,
  }));
}

/** Submitted responses to open interactions, plus each response's latest state. */
async function latestResponseRows(
  sessionId: string,
  resumeAfter: number,
  openInteractionIds: string[]
): Promise<EventRow[]> {
  if (!openInteractionIds.length) {
    return [];
  }
  const interactionId = sql<string>`${events.data}->'data'->>'interactionId'`;
  const responseId = sql<string>`${events.data}->'data'->>'responseId'`;
  const submittedWhere = and(
    eq(events.sessionId, sessionId),
    eq(events.type, "response.submitted"),
    sql`${events.line} <= ${resumeAfter}`,
    inArray(interactionId, openInteractionIds),
    isNotNull(responseId)
  );
  // The latest-state query filters by the submitted ids in SQL, so both reads
  // share one round trip instead of waiting on each other.
  const [submitted, latest] = await Promise.all([
    db()
      .selectDistinctOn([responseId], {
        data: events.data,
        index: events.index,
        line: events.line,
        type: events.type,
      })
      .from(events)
      .where(submittedWhere)
      .orderBy(asc(responseId), desc(events.line), desc(events.index)),
    db()
      .selectDistinctOn([responseId], {
        data: events.data,
        index: events.index,
        line: events.line,
        type: events.type,
      })
      .from(events)
      .where(
        and(
          eq(events.sessionId, sessionId),
          sql`${events.line} <= ${resumeAfter}`,
          inArray(events.type, [
            "response.admitted",
            "response.settled",
            "response.submitted",
          ]),
          inArray(
            responseId,
            db().select({ id: responseId }).from(events).where(submittedWhere)
          ),
          isNotNull(responseId)
        )
      )
      .orderBy(asc(responseId), desc(events.line), desc(events.index)),
  ]);
  return [
    ...new Map(
      [...submitted, ...latest].map((row) => [`${row.line}:${row.index}`, row])
    ).values(),
  ];
}

/**
 * Recover the small set of rows needed to render work that crosses the page
 * boundary. This is state-based rather than a fixed tail: an old open
 * interaction, task, call, or turn remains visible regardless of how many
 * unrelated tool events followed it.
 */
async function historyContextRows(
  sessionId: string,
  resumeAfter: number
): Promise<ClientRow[]> {
  const turnId = sql<string>`${events.data}->'data'->>'turnId'`;
  const taskId = sql<string>`${events.data}->'data'->>'taskId'`;
  const callId = sql<string>`${events.data}->'data'->>'callId'`;
  const deliveryId = sql<string>`${events.data}->'data'->>'deliveryId'`;
  const deliveryScopeTurnId = sql<string>`${events.data}->'scope'->>'turnId'`;
  const interactionId = sql<string>`${events.data}->'data'->>'interactionId'`;

  // Two independent chains, each two round trips deep: open turns feed their
  // deliveries; open interactions feed their latest responses.
  const turnRowsPromise = openScopedRows(
    turnId,
    sql`terminal.data->'data'->>'turnId'`,
    "turn.started",
    "turn.settled",
    sessionId,
    resumeAfter
  );
  const interactionRowsPromise = openScopedRows(
    interactionId,
    sql`terminal.data->'data'->>'interactionId'`,
    "interaction.opened",
    "interaction.settled",
    sessionId,
    resumeAfter
  );
  const [
    turnRows,
    taskRows,
    callRows,
    interactionRows,
    deliveryRows,
    responseRows,
  ] = await Promise.all([
    turnRowsPromise,
    openScopedRows(
      taskId,
      sql`terminal.data->'data'->>'taskId'`,
      "task.started",
      "task.ended",
      sessionId,
      resumeAfter,
      // eve ends an agent task with the call.settled of the call that started it and may send no
      // task.ended; the chat reducer (items.ts) reads it the same way. Otherwise it spins forever.
      sql`NOT EXISTS (
        SELECT 1
        FROM events AS start_call
        WHERE start_call.session_id = ${events.sessionId}
          AND start_call.type = 'call.settled'
          AND start_call.line <= ${resumeAfter}
          AND start_call.data->'data'->>'callId' = ${events.data}->'data'->'startedBy'->>'callId'
      )`
    ),
    openScopedRows(
      callId,
      sql`terminal.data->'data'->>'callId'`,
      "call.requested",
      "call.settled",
      sessionId,
      resumeAfter
    ),
    interactionRowsPromise,
    turnRowsPromise.then((rows) => {
      const openTurnIds = rows.flatMap((row) =>
        row.scopeId ? [row.scopeId] : []
      );
      // Older stream records sometimes carry the parent turn only in `scope`.
      // Match both shapes so paging cannot hide the user's prompt at a boundary.
      return openTurnIds.length
        ? openScopedRows(
            deliveryId,
            sql`terminal.data->'data'->>'deliveryId'`,
            "delivery.consumed",
            "delivery.settled",
            sessionId,
            resumeAfter,
            or(
              inArray(turnId, openTurnIds),
              inArray(deliveryScopeTurnId, openTurnIds)
            )
          )
        : [];
    }),
    interactionRowsPromise.then((rows) =>
      latestResponseRows(
        sessionId,
        resumeAfter,
        rows.flatMap((row) => (row.scopeId ? [row.scopeId] : []))
      )
    ),
  ]);

  const active = [
    ...turnRows,
    ...taskRows,
    ...callRows,
    ...deliveryRows,
    ...interactionRows,
  ];
  return [...active.map(rowFromEvent), ...responseRows.map(rowFromEvent)];
}

async function enrichHistoryContext(
  sessionId: string,
  rows: ClientRow[],
  pageSize: number,
  resumeAfter: number
): Promise<ClientRow[]> {
  if (rows.length < pageSize) {
    return rows;
  }
  return mergeHistoryRows(
    rows,
    await historyContextRows(sessionId, resumeAfter)
  );
}

/** Capture the durable line frontier before reading a bounded snapshot. */
async function resumeAfterFor(sessionId: string): Promise<number> {
  const [row] = await db()
    .select({
      line: events.line,
    })
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(desc(events.line), desc(events.index))
    .limit(1);
  return Number(row?.line ?? -1);
}

async function currentWindows(
  grouped: Map<string, ClientRow[]>,
  resumeAfters: Map<string, number>,
  selectedSessionId: string | null,
  selectedResumeAfter: number
): Promise<CurrentRowsResult> {
  const windows = new Map<string, ClientRow[]>();
  const history = new Map<string, HistoryWindow>();
  for (const [sessionId, sessionRows] of grouped) {
    const ordered = sessionRows.toSorted(
      (left, right) => left.line - right.line || left.index - right.index
    );
    const window = ordered.slice(-INITIAL_HISTORY_ROWS);
    windows.set(sessionId, window);
    if (sessionId === selectedSessionId) {
      const hasMore = ordered.length > INITIAL_HISTORY_ROWS;
      history.set(sessionId, {
        cursor:
          hasMore && window[0]
            ? { index: window[0].index, line: window[0].line }
            : null,
        hasMore,
        resumeAfter: selectedResumeAfter,
      });
    }
  }
  if (selectedSessionId) {
    const selected = windows.get(selectedSessionId) ?? [];
    if (selected.length >= INITIAL_HISTORY_ROWS) {
      windows.set(
        selectedSessionId,
        await span("chat.initial.historyContext", () =>
          enrichHistoryContext(
            selectedSessionId,
            selected,
            INITIAL_HISTORY_ROWS,
            selectedResumeAfter
          )
        )
      );
    }
  }
  return { history, resumeAfters, rows: windows };
}

/**
 * Every bot's current tail in one round trip, independent of the bots query.
 * The selected session (the slug, or the oldest bot without one) is resolved in
 * SQL so this can run in parallel with the directory read.
 */
async function currentRows(selected?: string): Promise<CurrentRowsResult> {
  const selectedSession = sql`(
    SELECT "session_id" FROM "bots"
    WHERE ${selected === undefined ? sql`true` : sql`"slug" = ${selected}`}
    ORDER BY "created_at", "id"
    LIMIT 1
  )`;
  const watermark = db()
    .select({ resumeAfter: events.line })
    .from(events)
    .where(eq(events.sessionId, bots.sessionId))
    .orderBy(desc(events.line), desc(events.index))
    .limit(1)
    .as("watermark");
  const sessions = db()
    .selectDistinct({
      resumeAfter: sql<number>`coalesce(${watermark.resumeAfter}, -1)`.as(
        "resume_after"
      ),
      selected:
        sql<boolean>`coalesce(${bots.sessionId} = ${selectedSession}, false)`.as(
          "selected"
        ),
      sessionId: bots.sessionId,
    })
    .from(bots)
    .leftJoinLateral(watermark, sql`true`)
    .where(isNotNull(bots.sessionId))
    .as("sessions");
  const recent = db()
    .select({
      data: events.data,
      index: events.index,
      line: events.line,
      type: events.type,
    })
    .from(events)
    // The grouped session row supplies a line watermark from the same
    // statement snapshot. This bounds every per-session tail, including
    // background previews, before the lateral LIMIT is applied.
    .where(
      and(
        eq(events.sessionId, sessions.sessionId),
        sql`${events.line} <= ${sessions.resumeAfter}`
      )
    )
    .orderBy(desc(events.line), desc(events.index))
    // Fetch one look-ahead row. The extra row is metadata only and is never
    // sent to the client; it makes an exact-size page distinguishable from a
    // page that has an older continuation.
    .limit(INITIAL_HISTORY_ROWS + 1)
    .as("recent");
  // One indexed LIMIT per session, in one round trip. A window over the entire
  // events table would scan unbounded histories before applying the row limit.
  const rows = await db()
    .select({
      data: recent.data,
      index: recent.index,
      line: recent.line,
      resumeAfter: sessions.resumeAfter,
      selected: sessions.selected,
      sessionId: sessions.sessionId,
      type: recent.type,
    })
    .from(sessions)
    .innerJoinLateral(recent, sql`true`)
    // Filter after each session's LIMIT, preserving its status window while
    // keeping background delivery/Markdown bodies off the database connection.
    .where(
      or(
        sessions.selected,
        notInArray(recent.type, ["delivery.consumed", "content.completed"])
      )
    )
    .orderBy(asc(recent.line), asc(recent.index));
  const grouped = new Map<string, ClientRow[]>();
  const resumeAfters = new Map<string, number>();
  let selectedSessionId: string | null = null;
  for (const { resumeAfter, selected: isSelected, sessionId, ...row } of rows) {
    if (!sessionId) {
      continue;
    }
    if (isSelected) {
      selectedSessionId = sessionId;
    }
    resumeAfters.set(sessionId, Number(resumeAfter));
    const list = grouped.get(sessionId) ?? [];
    list.push({ ...row, data: row.data as Fact });
    grouped.set(sessionId, list);
  }
  return currentWindows(
    grouped,
    resumeAfters,
    selectedSessionId,
    resumeAfters.get(selectedSessionId ?? "") ?? -1
  );
}

export async function recentRows(sessionId: string): Promise<ClientRow[]> {
  return (await recentRowsPage(sessionId)).rows;
}

export interface RecentRowsPage {
  hasMore: boolean;
  nextCursor: HistoryCursor | null;
  /** Last line observed before tail/context reads; the client replays from line - 1. */
  resumeAfter: number;
  rows: ClientRow[];
  sessionId: string;
}

export function parseHistoryCursor(value: string | null): HistoryCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      index?: unknown;
      line?: unknown;
    };
    return typeof parsed.line === "number" &&
      Number.isSafeInteger(parsed.line) &&
      parsed.line >= 0 &&
      typeof parsed.index === "number" &&
      Number.isSafeInteger(parsed.index) &&
      parsed.index >= 0
      ? { index: parsed.index, line: parsed.line }
      : null;
  } catch {
    return null;
  }
}

export async function recentRowsPage(
  sessionId: string,
  cursor: HistoryCursor | null = null,
  limit = ARCHIVED_HISTORY_ROWS
): Promise<RecentRowsPage> {
  const resumeAfter = await resumeAfterFor(sessionId);
  const rows = await db()
    .select({
      data: events.data,
      index: events.index,
      line: events.line,
      type: events.type,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, sessionId),
        sql`${events.line} <= ${resumeAfter}`,
        cursor
          ? or(
              sql`${events.line} < ${cursor.line}`,
              and(
                eq(events.line, cursor.line),
                sql`${events.index} < ${cursor.index}`
              )
            )
          : undefined
      )
    )
    .orderBy(desc(events.line), desc(events.index))
    .limit(limit + 1);
  const page = rows.slice(0, limit).reverse();
  const [oldest] = page;
  const pageRows = page.map((r) => ({ ...r, data: r.data as Fact }));
  const withContext = await enrichHistoryContext(
    sessionId,
    pageRows,
    limit,
    resumeAfter
  );
  return {
    hasMore: rows.length > limit,
    nextCursor:
      rows.length > limit && oldest
        ? { index: oldest.index, line: oldest.line }
        : null,
    resumeAfter,
    rows: prepareMarkdownRows(withContext),
    sessionId,
  };
}

/** Guard archive paging so a caller cannot probe another bot's session id. */
export async function archivedSessionOf(
  botId: string,
  current: string | null,
  sessionId: string
): Promise<boolean> {
  if (!sessionId || sessionId === current) {
    return false;
  }
  const sent = db()
    .select({ id: messages.deliveryId })
    .from(messages)
    .where(and(eq(messages.botId, botId), isNotNull(messages.deliveryId)));
  const [row] = await db()
    .select({ sessionId: events.sessionId })
    .from(events)
    .where(
      and(
        eq(events.botId, botId),
        eq(events.sessionId, sessionId),
        eq(events.type, "delivery.consumed"),
        inArray(sql`${events.data}->'data'->>'deliveryId'`, sent)
      )
    )
    .limit(1);
  return Boolean(row);
}

/** Earlier chat sessions eve replaced, oldest first: the ones that got the user's messages (not consultation threads). */
export async function pastSessions(
  botId: string,
  current: string | null
): Promise<PastSession[]> {
  const pages: PastSession[][] = [];
  let cursor: PastCursor | null = null;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: Each page cursor depends on the prior page.
    const page = await pastSessionsPage(botId, current, cursor);
    pages.unshift(page.past);
    cursor = page.nextCursor;
  } while (cursor);
  return pages.flat();
}

export interface PastSessionsPage {
  nextCursor: PastCursor | null;
  past: PastSession[];
}

export function parsePastCursor(value: string | null): PastCursor | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as {
      sessionId?: unknown;
      startedAt?: unknown;
    };
    return typeof parsed.sessionId === "string" &&
      CURSOR_ID.test(parsed.sessionId) &&
      typeof parsed.startedAt === "string" &&
      CURSOR_TIMESTAMP.test(parsed.startedAt) &&
      !Number.isNaN(Date.parse(parsed.startedAt))
      ? { sessionId: parsed.sessionId, startedAt: parsed.startedAt }
      : null;
  } catch {
    return null;
  }
}

export async function pastSessionsPage(
  botId: string,
  current: string | null,
  cursor: PastCursor | null = null,
  limit = PAST_SESSION_PAGE_SIZE
): Promise<PastSessionsPage> {
  const sent = db()
    .select({ id: messages.deliveryId })
    .from(messages)
    .where(and(eq(messages.botId, botId), isNotNull(messages.deliveryId)));
  const sessionStartedAt = sql<Date>`min(${events.at})`;
  const sessionStartedAtText = sql<string>`min(${events.at})::text`;
  const sessions = await db()
    .select({
      sessionId: events.sessionId,
      startedAt: sessionStartedAt,
      startedAtText: sessionStartedAtText,
    })
    .from(events)
    .where(
      and(
        eq(events.botId, botId),
        current ? ne(events.sessionId, current) : undefined,
        eq(events.type, "delivery.consumed"),
        inArray(sql`${events.data}->'data'->>'deliveryId'`, sent)
      )
    )
    .groupBy(events.sessionId)
    .having(
      cursor
        ? sql`${sessionStartedAt} < ${cursor.startedAt} OR (${sessionStartedAt} = ${cursor.startedAt} AND ${events.sessionId} < ${cursor.sessionId})`
        : undefined
    )
    .orderBy(desc(sessionStartedAt), desc(events.sessionId))
    .limit(limit + 1);
  // The first page is the newest archived sessions. A cursor is intentionally
  // opaque to the client; the server keeps the stable session ordering here.
  // Older pages are discovered by the same ordered session query and never
  // load their event bodies until that page is requested.
  const pageSessions = sessions.slice(0, limit);
  const past = await Promise.all(
    pageSessions.map(async (s) => {
      const page = await recentRowsPage(
        s.sessionId,
        null,
        ARCHIVED_HISTORY_ROWS
      );
      return {
        ...(page.hasMore
          ? {
              historyCursor: page.nextCursor,
              historyHasMore: true,
            }
          : {}),
        rows: page.rows,
        sessionId: s.sessionId,
      };
    })
  );
  const next = sessions.length > limit ? pageSessions.at(-1) : undefined;
  return {
    nextCursor: next
      ? {
          sessionId: next.sessionId,
          startedAt: String(next.startedAtText),
        }
      : null,
    past: past.reverse(),
  };
}

export type InitialBot = PublicBot & {
  historyCursor: HistoryCursor | null;
  historyHasMore: boolean;
  resumeAfter: number | null;
  rows: ClientRow[];
  consults: ConsultRef[];
  sessionId: string | null;
  past: PastSession[];
  pastLoaded: boolean;
  snapshotLoaded: boolean;
};

/**
 * Whether a bot has an archived chat session: `pastSessionsPage`'s filter,
 * existence only. Qualified by hand: drizzle drops table names on a
 * single-table select, which would compare the subquery's own columns.
 */
const hasArchive = sql<boolean>`exists (
  select 1 from "events" e
  where e."bot_id" = "bots"."id"
    and e."session_id" is distinct from "bots"."session_id"
    and e."type" = 'delivery.consumed'
    and e."data"->'data'->>'deliveryId' in (
      select m."delivery_id" from "messages" m
      where m."bot_id" = "bots"."id" and m."delivery_id" is not null
    )
)`;

/** Current conversations switch instantly. Archived sessions load only on request. */
export async function initialData(selected?: string): Promise<InitialBot[]> {
  // One round trip: none of these reads waits on another.
  const [all, current, consults] = await Promise.all([
    span("chat.initial.bots", () =>
      db()
        .select({ ...getTableColumns(bots), hasArchive })
        .from(bots)
        .where(sql`${bots.deletionState} is distinct from 'deleting'`)
        .orderBy(asc(bots.createdAt), asc(bots.id))
    ),
    span("chat.initial.rows", () => currentRows(selected)),
    span("chat.initial.consultations", () => consultationsFor()),
  ]);
  if (!all.length) {
    return [];
  }
  const active = selected ?? all[0]?.slug;
  return all.map((b) => {
    const currentRowsForBot = b.sessionId
      ? (current.rows.get(b.sessionId) ?? [])
      : [];
    const snapshotLoaded = b.slug === active;
    // Background rows only power status badges. Keep the last turn boundary and
    // its calls/interactions; large delivery and Markdown bodies load on intent.
    const preview = currentRowsForBot
      .slice(
        Math.max(
          0,
          currentRowsForBot.findLastIndex((row) => row.type === "turn.settled")
        )
      )
      .filter(
        (row) => !["delivery.consumed", "content.completed"].includes(row.type)
      )
      .map(compactRow);
    return {
      ...publicBot(b),
      consults: consults.get(b.id) ?? [],
      historyCursor: snapshotLoaded
        ? (current.history.get(b.sessionId ?? "")?.cursor ?? null)
        : null,
      historyHasMore: snapshotLoaded
        ? (current.history.get(b.sessionId ?? "")?.hasMore ?? false)
        : false,
      past: [],
      // A bot with no archived session has nothing earlier to offer.
      pastLoaded: !b.hasArchive,
      resumeAfter: b.sessionId
        ? (current.resumeAfters.get(b.sessionId) ?? -1)
        : null,
      rows: snapshotLoaded ? prepareMarkdownRows(currentRowsForBot) : preview,
      sessionId: b.sessionId,
      snapshotLoaded,
    };
  });
}

export async function consultationThread(id: string) {
  const [c] = await db()
    .select()
    .from(consultations)
    .where(eq(consultations.id, id));
  if (!c) {
    return null;
  }
  // Straight from Postgres: the sheet then follows the rest live (app/api/consultations/[id]/events).
  const [people, question, thread] = await Promise.all([
    db()
      .select({
        avatar: bots.avatar,
        billing: bots.billing,
        id: bots.id,
        name: bots.name,
        slug: bots.slug,
      })
      .from(bots)
      .where(
        inArray(bots.id, [c.fromBotId, ...(c.toBotId ? [c.toBotId] : [])])
      ),
    db()
      .select({ data: events.data })
      .from(events)
      .where(
        and(
          eq(events.sessionId, c.parentSessionId),
          eq(events.type, "call.requested"),
          sql`${events.data}->'data'->>'callId' = ${c.callId}`
        )
      )
      .limit(1),
    c.childSessionId
      ? recentRows(c.childSessionId)
      : Promise.resolve([] as ClientRow[]),
  ]);
  const who = (botId: string | null) =>
    people.find((p) => p.id === botId) ?? null;
  const input = (question[0]?.data as Fact | undefined)?.data?.input as
    | { message?: string }
    | undefined;
  return {
    from: who(c.fromBotId),
    id: c.id,
    question: input?.message ?? null,
    rows: thread,
    to: who(c.toBotId),
  };
}
