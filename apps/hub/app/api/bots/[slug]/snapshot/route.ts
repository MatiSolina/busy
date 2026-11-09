import { getBot } from "@/lib/bots/service";
import {
  ARCHIVED_HISTORY_ROWS,
  archivedSessionOf,
  consultationsOf,
  parseHistoryCursor,
  recentRowsPage,
} from "@/lib/chat/initial";
import { type Stages, serverTiming, span } from "@/lib/trace";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const stages: Stages = {};
  const bot = await span("snapshot.bot", () => getBot(slug), stages);
  if (!bot) {
    return new Response("not found", { status: 404 });
  }
  const search = new URL(req.url).searchParams;
  const rawCursor = search.get("before");
  const requestedSession = search.get("session");
  const archiveSession = search.get("archive");
  if (requestedSession && requestedSession !== bot.sessionId) {
    return new Response("stale session", { status: 409 });
  }
  const cursor = parseHistoryCursor(rawCursor);
  if (rawCursor !== null && !cursor) {
    return new Response("invalid cursor", { status: 400 });
  }
  if (archiveSession !== null && !archiveSession) {
    return new Response("invalid archive session", { status: 400 });
  }
  if (
    archiveSession &&
    !(await span(
      "snapshot.archive",
      () => archivedSessionOf(bot.id, bot.sessionId, archiveSession),
      stages
    ))
  ) {
    return new Response("archive not found", { status: 404 });
  }
  const targetSession = archiveSession ?? bot.sessionId;
  const pagePromise = targetSession
    ? span(
        "snapshot.rows",
        () =>
          recentRowsPage(
            targetSession,
            cursor,
            // Opening a chat stays small; paging back takes bigger steps so it keeps ahead of the reader.
            archiveSession || cursor ? ARCHIVED_HISTORY_ROWS : 120
          ),
        stages
      )
    : Promise.resolve({
        hasMore: false,
        nextCursor: null,
        resumeAfter: -1,
        rows: [],
        sessionId: null,
      });
  const [page, consults] = await Promise.all([
    pagePromise,
    span("snapshot.consultations", () => consultationsOf(bot.id), stages),
  ]);
  return Response.json(
    {
      consults,
      historyCursor: page.nextCursor,
      historyHasMore: page.hasMore,
      historySessionId: page.sessionId,
      // This is the pre-read line frontier, not the max line of context rows.
      // The client resumes from one line before it to replay a complete final line.
      resumeAfter: page.resumeAfter,
      rows: page.rows,
      sessionId: bot.sessionId,
    },
    {
      headers: {
        "Cache-Control": "private, no-store",
        "Server-Timing": serverTiming(stages),
      },
    }
  );
}
