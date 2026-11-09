import { aiIssue, issueResponse } from "@/lib/ai/errors";
import { getBot } from "@/lib/bots/service";
import { sanitizeAiFact } from "@/lib/chat/model-errors";
import {
  errorCodeOf,
  logChatObservation,
  requestIdOf,
} from "@/lib/chat/observability";
import { persistedEvents, persistedTailEvents } from "@/lib/chat/send";
import { relay, sseResponse } from "@/lib/chat/sse";
import { botCall, cursorOf, saver } from "@/lib/chat/store";
import { readStream } from "@/lib/eve/client";
import { type Stages, span } from "@/lib/trace";

interface Ctx {
  params: Promise<{ slug: string }>;
}

/**
 * SSE for the app: first the stored events after `?after=<line>`, then the live
 * stream, persisting each line as it passes (the same rows the cron writes).
 * The client reconnects with its last line and session;
 * if eve replaced the session since, it gets a `session` event and the new one from the start.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { slug } = await params;
  const stages: Stages = {};
  let bot = await span("events.bot", () => getBot(slug), stages);
  // A rotated bot gets its next session with the next message: wait for it rather than fail.
  for (
    let i = 0;
    bot?.status === "ready" && !bot.sessionId && i < 100 && !req.signal.aborted;
    i += 1
  ) {
    // biome-ignore lint/performance/noAwaitInLoops: The retry delay and fresh bot read must remain sequential.
    await new Promise((r) => setTimeout(r, 2000));
    bot = await span("events.bot", () => getBot(slug), stages);
  }
  if (!bot?.sessionId) {
    return issueResponse(
      aiIssue("pending", null, {
        message: "The bot has no conversation yet. Send it a message first.",
      }),
      409
    );
  }
  const ready = bot;
  const { sessionId } = bot;
  const query = new URL(req.url).searchParams;
  const requestedSession = query.get("session");
  const sessionChanged =
    requestedSession !== null && requestedSession !== sessionId;
  const after = sessionChanged ? -1 : Number(query.get("after") ?? -1);
  const requestId = requestIdOf(req);

  return sseResponse(req, async (send, closed, signal) => {
    try {
      // Cursor first, then stored rows, then live from the cursor: a line the client got but the
      // DB never saved (function cut mid-save) is read again instead of lost. The client dedups.
      send("session", { sessionId });
      if (sessionChanged) {
        // The client will fetch a bounded snapshot for this new session before
        // reconnecting with its fresh line cursor. Do not replay the old
        // cursor or accidentally stream an unbounded new-session history.
        return;
      }
      const start = await span(
        "events.cursor",
        () => cursorOf(sessionId),
        stages
      );
      const replayed = await span(
        "events.replay",
        async () =>
          after < 0
            ? await persistedTailEvents(sessionId)
            : await persistedEvents(sessionId, after),
        stages
      );
      for (const r of replayed) {
        send(
          "fact",
          { ...r, data: sanitizeAiFact(r.data, ready.billing) },
          r.line
        );
      }
      await relay(
        readStream(botCall(ready.slug), sessionId, start, true, signal),
        saver(ready, sessionId, true),
        send,
        closed,
        ready.billing,
        { botSlug: ready.slug, requestId, sessionId, stages }
      );
    } catch (error) {
      logChatObservation("chat.stream", {
        botSlug: ready.slug,
        errorCode: errorCodeOf(error),
        outcome: "failed",
        requestId,
        sessionId,
      });
      throw error;
    }
  });
}

export const maxDuration = 300;
