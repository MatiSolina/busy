import { getBot } from "@/lib/bots/service";
import {
  errorCodeOf,
  logChatObservation,
  requestIdOf,
} from "@/lib/chat/observability";
import { botCall } from "@/lib/chat/store";
import { cancelTurn, prewarmSession } from "@/lib/eve/client";

interface Ctx {
  params: Promise<{ slug: string }>;
}

// Wakes the bot ahead of a message the user is typing (docs/chat-prewarm.md). eve's prewarm never
// starts a turn or calls a model. It warms the bot's `__server` function, the hub's token and
// connection, and eve's hook lookup; the queue-triggered `flow` function only wakes when eve moves
// the session to a newer deployment (`accepted`).
//
// BUSY_EVE_WARM_FLOW=1 also wakes `flow`, where the cold start actually is: a cancel guarded by
// `turnId: null` cancels nothing (eve settles it `ignored`) but still runs hook → queue → flow. It
// goes after the prewarm, not instead of it: the prewarm is what moves a session to the current
// deployment, so the cancel then lands on the flow the next message will use. Skipped when the
// prewarm answered `accepted`, which already queued work on flow.
export async function POST(req: Request, { params }: Ctx) {
  const prewarm = process.env.BOT_PREWARM === "1";
  const flow = process.env.BUSY_EVE_WARM_FLOW === "1";
  if (!(prewarm || flow)) {
    return new Response(null, { status: 204 });
  }
  const variant = [prewarm && "prewarm", flow && "flow"]
    .filter(Boolean)
    .join("+");
  const startedAt = Date.now();
  const { slug } = await params;
  const observe = (outcome: string, fields: Record<string, string> = {}) =>
    logChatObservation("message.warm", {
      botSlug: slug,
      durationMs: Date.now() - startedAt,
      outcome,
      requestId: requestIdOf(req),
      variant,
      ...fields,
    });
  const bot = await getBot(slug);
  if (!bot) {
    observe("not_found");
    return new Response(null, { status: 404 });
  }
  // No session yet: creating one has effects (a sandbox, history seeding), so the first send does it.
  if (bot.status !== "ready" || !bot.sessionId) {
    observe("skipped");
    return new Response(null, { status: 204 });
  }
  try {
    const call = botCall(bot.slug);
    const status = prewarm
      ? await prewarmSession(call, bot.sessionId)
      : undefined;
    const flowWoken = flow && status !== "accepted";
    if (flowWoken) {
      await cancelTurn(call, bot.sessionId, null);
    }
    observe("success", {
      flow: flowWoken ? "woken" : "skipped",
      sessionId: bot.sessionId,
      ...(status && { status }),
    });
    return Response.json({ status });
  } catch (error) {
    // Best effort: the send keeps its own retries.
    observe("failed", { errorCode: errorCodeOf(error) });
    return new Response(null, { status: 502 });
  }
}
