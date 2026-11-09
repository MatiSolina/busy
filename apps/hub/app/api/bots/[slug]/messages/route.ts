import { after } from "next/server";
import { z } from "zod";
import { aiIssue, issueResponse } from "@/lib/ai/errors";
import { getBot } from "@/lib/bots/service";
import {
  deliverMessage,
  ensureMessage,
  followTurn,
  type MessagePayload,
  type MessageRow,
  markMessageFailed,
  payloadHash,
} from "@/lib/chat/deliver";
import {
  fastDeliveryId,
  fastPathEnabled,
  routeFast,
} from "@/lib/chat/fast-path";
import {
  fastIneligible,
  persistAck,
  runFastReply,
} from "@/lib/chat/fast-reply";
import {
  errorCodeOf,
  logChatObservation,
  requestIdOf,
} from "@/lib/chat/observability";
import { validTimeZone } from "@/lib/routines/validation";
import { type Stages, serverTiming, span, stageFields } from "@/lib/trace";

const clientContext = z.strictObject({
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine(validTimeZone, "Invalid IANA time zone."),
});

// Skills are no longer picked per message. A client built before that, or a retry of a message
// stored before that, still sends the references it picked: they only take part in the payload
// hash, so the retry matches its stored row. Their content is never loaded or sent.
const legacySkillRef = z.strictObject({
  capabilityId: z.uuid(),
  skillName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u),
});

const input = z.object({
  clientContext: clientContext.optional(),
  fileIds: z.array(z.uuid()).max(6).default([]),
  id: z.uuid(),
  selectedSkills: z.array(legacySkillRef).max(4).default([]),
  text: z.string().max(20_000),
});

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isSameLegacyPayload(
  row: {
    clientContext?: { timeZone?: string } | null;
    fileIds?: string[];
    text?: string;
  },
  payload: MessagePayload
) {
  return (
    row.text === payload.text &&
    sameJson(row.fileIds ?? [], payload.fileIds) &&
    sameJson(row.clientContext ?? null, payload.clientContext)
  );
}

function messageConflict(
  row: MessageRow,
  botId: string,
  hash: string,
  payload: MessagePayload
) {
  if (row.botId !== botId) {
    return Response.json(
      { error: "This message id belongs to another bot." },
      { status: 409 }
    );
  }
  if (
    row.payloadHash
      ? row.payloadHash !== hash
      : !isSameLegacyPayload(row, payload)
  ) {
    return Response.json(
      { error: "This message id was already used with different content." },
      { status: 409 }
    );
  }
  return null;
}

interface Ctx {
  params: Promise<{ slug: string }>;
}

// The app's message id is eve's idempotencyKey: a retry never runs twice (spec 4.3).
export async function POST(req: Request, { params }: Ctx) {
  const startedAt = Date.now();
  const requestId = requestIdOf(req);
  const { slug } = await params;
  const stages: Stages = {};
  const observe = (
    outcome: string,
    fields: Record<string, string | undefined> = {}
  ) =>
    logChatObservation("message.post", {
      botSlug: slug,
      durationMs: Date.now() - startedAt,
      outcome,
      requestId,
      ...stageFields(stages),
      ...fields,
    });
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (
    !(parsed.success && (parsed.data.text.trim() || parsed.data.fileIds.length))
  ) {
    observe("invalid_data");
    return issueResponse(aiIssue("invalid_data"), 400);
  }
  const bot = await span("message.bot", () => getBot(slug), stages);
  if (!bot) {
    observe("not_found");
    return issueResponse(aiIssue("not_found"), 404);
  }
  if (bot.status !== "ready") {
    observe("not_ready");
    return issueResponse(
      aiIssue("message_delivery_failed", null, {
        message: "The bot is still being set up.",
      }),
      409
    );
  }
  const {
    clientContext: messageContext,
    fileIds,
    id,
    selectedSkills,
    text,
  } = parsed.data;
  const payload: MessagePayload = {
    botId: bot.id,
    clientContext: messageContext ?? null,
    fileIds,
    selectedSkills,
    text,
  };
  const hash = payloadHash(payload);
  const resolution = await span(
    "message.insert",
    () => ensureMessage(bot.id, id, payload, hash),
    stages
  );
  if ("error" in resolution) {
    observe("conflict", { messageId: id });
    return resolution.error;
  }
  const { row } = resolution;
  const conflict = messageConflict(row, bot.id, hash, payload);
  if (conflict) {
    observe("conflict", { messageId: id });
    return conflict;
  }
  if (row.status === "accepted") {
    observe("already_accepted", {
      deliveryId: row.deliveryId ?? undefined,
      messageId: id,
    });
    return Response.json({ deliveryId: row.deliveryId });
  }

  // Retries send the stored payload, never what this request carried.
  const deliver = async (fastAck?: string) => {
    try {
      const { deliveryId, sessionId } = await deliverMessage({
        bot,
        createdAt: row.createdAt,
        fastAck,
        fileIds: row.fileIds,
        id,
        messageContext: row.clientContext,
        stages,
        text: row.text,
      });
      observe("accepted", { deliveryId, messageId: id, sessionId });
      // Delivery is already durable. Maintenance must not delay its acknowledgement or the UI handoff.
      // The follower reads the session that admitted it, even if the bot rotates meanwhile.
      after(() => followTurn(bot, deliveryId, sessionId));
      return deliveryId;
    } catch (error) {
      // Never downgrades an accepted receipt; an unknown delivery stays pending for the same session.
      await markMessageFailed(id, error);
      observe("failed", {
        errorCode: "message_delivery_failed",
        messageId: id,
      });
      return null;
    }
  };

  // `?reconcile=1`: the client lost a fast response before its final line and asks what became of
  // this id. It never runs another fast turn; the normal path answers from the stored row or eve's
  // idempotency key.
  const reconcile = new URL(req.url).searchParams.get("reconcile") === "1";
  if (fastPathEnabled(slug) && !reconcile) {
    const route = routeFast({ fileIds: row.fileIds, text: row.text });
    const decision = route.fast
      ? await span("fast.eligible", () => fastIneligible(bot, id), stages)
      : route.reason;
    if (decision === null) {
      return fastResponse(
        bot,
        id,
        row.text,
        stages,
        requestId,
        deliver,
        route.fast ? route.mustEscalate : undefined
      );
    }
    logChatObservation("message.fast", {
      botSlug: slug,
      decision,
      messageId: id,
      outcome: "skipped",
      requestId,
    });
  }

  const deliveryId = await deliver();
  if (!deliveryId) {
    // Transport, file and eve errors can contain provider credentials or response bodies. Keep
    // this endpoint's contract deliberately generic: model/provider failures arrive later in the
    // persisted stream and are classified there with their bot's billing mode.
    return issueResponse(aiIssue("message_delivery_failed"), 502);
  }
  return Response.json(
    { deliveryId },
    { headers: { "Server-Timing": serverTiming(stages) } }
  );
}

type FastResultAck = Awaited<ReturnType<typeof runFastReply>>["ack"];

/**
 * A fast turn answers as newline-delimited JSON: `{fact}` and `{progress}` lines shaped like the
 * SSE stream's, `{retract}` if a shown draft is dropped, and a final `{deliveryId}` (or `{error}`).
 * An escalation or a model failure falls back to the normal delivery in the same response.
 */
function fastResponse(
  bot: NonNullable<Awaited<ReturnType<typeof getBot>>>,
  id: string,
  text: string,
  stages: Stages,
  requestId: string | undefined,
  deliver: (fastAck?: string) => Promise<string | null>,
  mustEscalate?: "files" | "url"
): Response {
  const encoder = new TextEncoder();
  const startedAt = performance.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The user left: the reply is still stored and shows on reload.
        }
      };
      const log = (
        fields: Record<string, number | string | boolean | undefined>
      ) =>
        logChatObservation("message.fast", {
          botSlug: bot.slug,
          decision: "fast",
          messageId: id,
          provider: bot.billing,
          requestId,
          totalMs: Math.round(performance.now() - startedAt),
          ...stageFields(stages),
          ...fields,
        });
      // The ack stays only if eve took the message and its rows are stored; otherwise it goes, as a
      // draft does today, and the client shows the message as pending (or failed) again.
      const keepAck = async (
        ack: NonNullable<FastResultAck>,
        eveDelivery: string | null
      ) => {
        try {
          if (!eveDelivery) {
            throw new Error("not_delivered");
          }
          for (const r of await persistAck(
            bot,
            ack,
            id,
            text,
            eveDelivery,
            stages
          )) {
            emit({ fact: r });
          }
        } catch {
          emit({ retract: true });
        }
      };
      let deliveryId: string | null = null;
      let delivered = false;
      try {
        const result = await runFastReply(
          { bot, messageId: id, mustEscalate, text },
          emit,
          stages
        );
        if (!result.escalated) {
          deliveryId = fastDeliveryId(id);
        }
        if (result.status) {
          emit({ status: result.status });
        }
        log({
          ...(result.ack ? { acked: true, ackMs: result.ttftMs } : {}),
          escalated: result.escalated,
          inputTokens: result.inputTokens,
          outcome: "completed",
          outputTokens: result.outputTokens,
          ttftMs: result.ttftMs,
        });
        if (result.ack) {
          delivered = true;
          deliveryId = await deliver(result.ack.reply);
          await keepAck(result.ack, deliveryId);
        }
      } catch (error) {
        log({
          errorCode: errorCodeOf(error),
          escalated: true,
          outcome: "failed",
        });
      }
      if (!delivered) {
        deliveryId ??= await deliver();
      }
      emit(deliveryId ? { deliveryId } : { error: "message_delivery_failed" });
      try {
        controller.close();
      } catch {
        // Already closed by the client.
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store, no-transform",
      "Content-Type": "application/x-ndjson",
    },
  });
}

export const maxDuration = 60;
