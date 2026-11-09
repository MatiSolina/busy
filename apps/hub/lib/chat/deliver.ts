import { createHash } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { start } from "workflow/api";
import type { getBot } from "@/lib/bots/service";
import {
  fastPathEnabled,
  withFastAck,
  withFastExchanges,
} from "@/lib/chat/fast-path";
import { pendingFastExchanges } from "@/lib/chat/fast-reply";
import { sendToBot } from "@/lib/chat/send";
import { db, messageDeliveryAttempts, messages } from "@/lib/db";
import { fileForMessage } from "@/lib/files";
import { keepOn } from "@/lib/keep-on";
import { linkFileProvenance } from "@/lib/library-objects";
import { KEEP_ON_MS } from "@/lib/live";
import { type Stages, span } from "@/lib/trace";
import { syncTurnWorkflow } from "@/workflows/sync-turn";

// Shared by POST /api/bots/[slug]/messages and the latency probe cron: one delivery path.
export interface MessagePayload {
  botId: string;
  clientContext: { timeZone: string } | null;
  fileIds: string[];
  // Hash compatibility only: empty from current clients (see `legacySkillRef`).
  selectedSkills: Array<{ capabilityId: string; skillName: string }>;
  text: string;
}

export function payloadHash(payload: MessagePayload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type MessageRow = typeof messages.$inferSelect;

function pendingMessageWhere(id: string) {
  return and(
    eq(messages.id, id),
    ne(messages.status, "accepted"),
    isNull(messages.deliveryId)
  );
}

type MessageResolution = { error: Response } | { row: MessageRow };

export async function ensureMessage(
  botId: string,
  id: string,
  payload: MessagePayload,
  hash: string
): Promise<MessageResolution> {
  // New messages need one round trip. Only retries/conflicts read the existing row afterward.
  let [row] = await db()
    .insert(messages)
    .values({
      botId,
      clientContext: payload.clientContext,
      fileIds: payload.fileIds,
      id,
      payloadHash: hash,
      selectedSkills: payload.selectedSkills,
      text: payload.text,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    [row] = await db().select().from(messages).where(eq(messages.id, id));
  }
  if (!row) {
    return { error: new Response("conflict", { status: 409 }) };
  }
  return { row };
}

export async function deliverMessage({
  bot,
  createdAt = new Date(),
  fastAck,
  fileIds,
  id,
  text,
  messageContext,
  stages,
}: {
  bot: NonNullable<Awaited<ReturnType<typeof getBot>>>;
  /** The message row's: fast exchanges before it, and after the last normal message, ride along. */
  createdAt?: Date;
  /** The line the fast path already showed for this message (`FAST_PATH_ACK`). */
  fastAck?: string;
  messageContext: { timeZone?: string } | null | undefined;
  fileIds: string[];
  id: string;
  stages: Stages;
  text: string;
}) {
  const files = await span(
    "message.files",
    async () => {
      await Promise.all(
        fileIds.map((fileId) =>
          linkFileProvenance(bot.id, fileId, {
            messageId: id,
          })
        )
      );
      return Promise.all(
        fileIds.map((fileId) => fileForMessage(bot.id, fileId))
      );
    },
    stages,
    { "busy.files": fileIds.length }
  );
  // Off by default: with FAST_PATH_BOTS unset there are no fast exchanges and no extra query.
  const fastContext = fastPathEnabled(bot.slug)
    ? withFastExchanges(
        messageContext,
        await span(
          "message.fastContext",
          () => pendingFastExchanges(bot.id, createdAt),
          stages
        )
      )
    : messageContext;
  const clientContext = withFastAck(fastContext, fastAck);
  const result = await sendToBot(
    bot,
    {
      files,
      id,
      text,
      ...(clientContext ? { clientContext } : {}),
    },
    stages
  );
  // The session that admitted it (H-35, N-04): the delivery identity pinned it before the POST.
  const [admitted] = await db()
    .select({ sessionId: messageDeliveryAttempts.sessionId })
    .from(messageDeliveryAttempts)
    .where(eq(messageDeliveryAttempts.messageId, id));
  const sessionId = admitted?.sessionId ?? undefined;
  try {
    await span(
      "message.accept",
      () =>
        db()
          .update(messages)
          .set({
            deliveryId: result.deliveryId,
            ...(sessionId ? { sessionId } : {}),
            status: "accepted",
          })
          // A concurrent retry may have recorded acceptance first. Never move
          // an already accepted message backwards or overwrite it.
          .where(pendingMessageWhere(id)),
      stages
    );
  } catch (error) {
    const unknown = new Error(
      "The delivery was accepted but its receipt could not be persisted.",
      { cause: error }
    );
    unknown.name = "UnknownDeliveryError";
    throw unknown;
  }
  return { ...result, sessionId };
}

/** Post-ack maintenance: follow the turn durably and keep the computer on. Never throws. */
export async function followTurn(
  bot: NonNullable<Awaited<ReturnType<typeof getBot>>>,
  deliveryId: string,
  /** The session that admitted the delivery (absent only for callers that never learned it). */
  sessionId?: string
): Promise<void> {
  await Promise.all([
    start(
      syncTurnWorkflow,
      sessionId ? [bot.slug, deliveryId, sessionId] : [bot.slug, deliveryId]
    ).catch(() => {
      // The hourly reconciliation job retries this durable sync.
    }),
    keepOn(bot, KEEP_ON_MS).catch(() => {
      // Keeping the computer on is best effort and must not fail delivery.
    }),
  ]);
}

export async function markMessageFailed(
  id: string,
  error?: unknown
): Promise<void> {
  // An Eve success is authoritative even if the following database write was
  // interrupted. Unknown deliveries stay pending for same-session retry.
  if (error instanceof Error && error.name === "UnknownDeliveryError") {
    return;
  }
  await db()
    .update(messages)
    .set({ status: "failed" })
    .where(pendingMessageWhere(id));
}
