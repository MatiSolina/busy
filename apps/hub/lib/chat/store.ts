import { getVercelOidcToken } from "@vercel/oidc";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Billing } from "../bots/models";
import { type BotRow, bots, consultations, cursors, db, events } from "../db";
import { need } from "../env";
import {
  type BotCall,
  childStreamPath,
  readStream,
  readStreamAt,
} from "../eve/client";
import { signHubToken } from "../hub-token";
import { observeOperation } from "../operation-observability";
import { sanitizeAiFact } from "./model-errors";
import { errorCodeOf, logChatObservation } from "./observability";
import {
  bindConsultationPeers,
  defaultPeerBinding,
  isEveSessionId,
  type PeerBindingDeps,
} from "./peer-binding";
import { consultationFromFact, type EventRow, syncSession } from "./sync";

export function botCall(slug: string): BotCall {
  // Local dev goes through the deployed relay: it checks our pulled busy-hub OIDC token and signs
  // for us. HUB_SIGNING_KEY lives only in production.
  const relay = process.env.DEV_RELAY_URL;
  if (relay) {
    return {
      token: () => getVercelOidcToken(),
      url: `${relay}/api/dev/bots/${slug}`,
    };
  }
  return {
    // One-bot, 5-minute token: our OIDC token was valid on every bot (lib/hub-token.ts).
    token: () => signHubToken(slug),
    url: `https://${slug}.${need("BOTS_DOMAIN")}`,
  };
}

type ConsultationOperation =
  | {
      callId: string;
      childSessionId: string;
      kind: "open";
      toBotId: string | null;
    }
  | {
      callId: string;
      childSessionId?: string;
      kind: "done";
      terminalOutcome: "completed" | "failed" | "skipped";
    };

interface ConsultationObservation {
  callId: string;
  childSessionId: string | null;
  id: string;
  outcome: "completed" | "started" | "failed" | "skipped";
  stage: "session" | "terminal";
}

// Keep one saver transaction atomic while staying below PostgreSQL's 65,535 bind
// parameter limit for a single oversized SDK record.
const MAX_EVENT_INSERT_ROWS = 1000;
const MAX_CONSULTATION_LOOKUP_IDS = 1000;
type DatabaseTransaction = Parameters<
  Parameters<ReturnType<typeof db>["transaction"]>[0]
>[0];

async function persistConsultationOperations(
  tx: DatabaseTransaction,
  bot: BotRow,
  sessionId: string,
  operations: ConsultationOperation[],
  observations: ConsultationObservation[]
): Promise<void> {
  const openByCall = new Map<
    string,
    { childSessionId: string | null; id: string }
  >();
  const doneOperations = operations.filter(
    (
      operation
    ): operation is Extract<ConsultationOperation, { kind: "done" }> =>
      operation.kind === "done"
  );
  const terminalCallIds = [
    ...new Set(doneOperations.map((operation) => operation.callId)),
  ];
  for (
    let offset = 0;
    offset < terminalCallIds.length;
    offset += MAX_CONSULTATION_LOOKUP_IDS
  ) {
    const callIds = terminalCallIds.slice(
      offset,
      offset + MAX_CONSULTATION_LOOKUP_IDS
    );
    // biome-ignore lint/performance/noAwaitInLoops: keep bounded reads in one transaction
    const existing = await tx
      .select({
        callId: consultations.callId,
        childSessionId: consultations.childSessionId,
        id: consultations.id,
      })
      .from(consultations)
      .where(
        and(
          eq(consultations.fromBotId, bot.id),
          eq(consultations.parentSessionId, sessionId),
          eq(consultations.status, "open"),
          inArray(consultations.callId, callIds)
        )
      );
    for (const row of existing) {
      openByCall.set(row.callId, row);
    }
  }
  for (const operation of operations) {
    if (operation.kind === "open") {
      // Consultation rows must remain in stream order: status updates can refer to an open
      // created earlier in this same batch.
      // biome-ignore lint/performance/noAwaitInLoops: order is part of the persistence contract
      const [inserted] = await tx
        .insert(consultations)
        .values({
          callId: operation.callId,
          childSessionId: operation.childSessionId,
          fromBotId: bot.id,
          parentSessionId: sessionId,
          toBotId: operation.toBotId,
        })
        .onConflictDoNothing()
        .returning({
          childSessionId: consultations.childSessionId,
          id: consultations.id,
        });
      if (inserted) {
        openByCall.set(operation.callId, inserted);
        observations.push({
          callId: operation.callId,
          childSessionId: inserted.childSessionId,
          id: inserted.id,
          outcome: "started",
          stage: "session",
        });
      }
      continue;
    }
    const open = openByCall.get(operation.callId);
    if (
      !open ||
      (operation.childSessionId &&
        operation.childSessionId !== open.childSessionId)
    ) {
      continue;
    }
    const [updated] = await tx
      .update(consultations)
      .set({ status: "done" })
      .where(
        and(
          eq(consultations.id, open.id),
          eq(consultations.callId, operation.callId),
          eq(consultations.fromBotId, bot.id),
          eq(consultations.parentSessionId, sessionId),
          eq(consultations.status, "open")
        )
      )
      .returning({
        childSessionId: consultations.childSessionId,
        id: consultations.id,
      });
    openByCall.delete(operation.callId);
    if (updated) {
      observations.push({
        callId: operation.callId,
        childSessionId: updated.childSessionId,
        id: updated.id,
        outcome: operation.terminalOutcome,
        stage: "terminal",
      });
    }
  }
}

async function consultationOperations(
  bot: BotRow,
  parentSessionId: string,
  rows: EventRow[],
  binding: PeerBindingDeps
): Promise<ConsultationOperation[]> {
  const opens = rows.flatMap((r) => {
    const c = consultationFromFact(r.data);
    return c ? [c] : [];
  });
  const valid = opens.filter((c) => isEveSessionId(c.childSessionId));
  // Bounded, before the save transaction (lib/chat/peer-binding.ts).
  const bound = await bindConsultationPeers(
    bot,
    parentSessionId,
    valid,
    binding
  );
  const childSessions = new Map<string, string>();
  const operations: ConsultationOperation[] = [];
  for (const r of rows) {
    const c = consultationFromFact(r.data);
    if (c) {
      const peer = bound.get(c.callId);
      if (!peer) {
        // Not an eve session id: neither probed nor stored as a thread path.
        logConsultationBinding(bot, c, "invalid_child_session");
        continue;
      }
      if (peer.reason && peer.reason !== "already_recorded") {
        // Metadata only: unattributed rather than charged to another bot.
        logConsultationBinding(bot, c, peer.reason);
      }
      operations.push({
        callId: c.callId,
        childSessionId: c.childSessionId,
        kind: "open",
        toBotId: peer.toBotId,
      });
      childSessions.set(c.callId, c.childSessionId);
    } else if (r.type === "call.settled") {
      const { callId } = r.data.data;
      const childSessionId =
        typeof callId === "string" ? childSessions.get(callId) : undefined;
      if (typeof callId === "string") {
        operations.push({
          callId,
          childSessionId,
          kind: "done",
          terminalOutcome: consultationTerminalOutcome(r.data.data.outcome),
        });
      }
    }
  }
  return operations;
}

function logConsultationBinding(
  bot: BotRow,
  c: { callId: string },
  reason: string
): void {
  console.warn(
    JSON.stringify({
      botId: bot.id,
      callId: c.callId,
      reason,
      source: "busy.consultation",
    })
  );
}

function consultationTerminalOutcome(
  value: unknown
): "completed" | "failed" | "skipped" {
  if (value === "completed") {
    return "completed";
  }
  if (value === "cancelled" || value === "interrupted" || value === "skipped") {
    return "skipped";
  }
  return "failed";
}

function observeConsultationOperations(
  bot: BotRow,
  parentSessionId: string,
  observations: ConsultationObservation[]
): void {
  for (const observation of observations) {
    observeOperation({
      botId: bot.id,
      callId: observation.callId,
      childSessionId: observation.childSessionId,
      entryPoint: "internal",
      flow: "consultation",
      operationId: observation.id,
      outcome: observation.outcome,
      parentSessionId,
      sessionId: observation.childSessionId ?? parentSessionId,
      stage: observation.stage,
    });
  }
}

export async function cursorOf(sessionId: string): Promise<number> {
  const [row] = await db()
    .select()
    .from(cursors)
    .where(eq(cursors.sessionId, sessionId));
  return row?.nextLine ?? 0;
}

export function saver(
  bot: BotRow,
  sessionId: string,
  trackConsultations: boolean,
  providerHint: Billing | null = bot.billing,
  binding: PeerBindingDeps = defaultPeerBinding
) {
  return async (rows: EventRow[], nextLine: number) => {
    const q = db();
    const startedAt = Date.now();
    const consultationObservations: ConsultationObservation[] = [];
    let hasConsultationOpen = false;
    try {
      const consultationOps = trackConsultations
        ? await consultationOperations(bot, sessionId, rows, binding)
        : [];
      hasConsultationOpen = consultationOps.some((op) => op.kind === "open");
      await q.transaction(async (tx) => {
        if (rows.length) {
          const eventValues = rows.map((r) => ({
            at: r.at,
            botId: bot.id,
            data: sanitizeAiFact(r.data, providerHint),
            index: r.index,
            line: r.line,
            sessionId,
            type: r.type,
          }));
          for (
            let offset = 0;
            offset < eventValues.length;
            offset += MAX_EVENT_INSERT_ROWS
          ) {
            // Keep all chunks in this transaction so event/cursor/consultation
            // recovery remains atomic even for a single very large record.
            // biome-ignore lint/performance/noAwaitInLoops: chunks must remain ordered in one transaction
            await tx
              .insert(events)
              .values(eventValues.slice(offset, offset + MAX_EVENT_INSERT_ROWS))
              .onConflictDoNothing();
          }
        }
        await tx
          .insert(cursors)
          .values({ botId: bot.id, nextLine, sessionId })
          .onConflictDoUpdate({
            set: { nextLine: sql`greatest(${cursors.nextLine}, ${nextLine})` },
            target: cursors.sessionId,
          });
        // Keep event/cursor and consultation state atomic. Otherwise a
        // consultation error advances the cursor past a retryable fact.
        await persistConsultationOperations(
          tx,
          bot,
          sessionId,
          consultationOps,
          consultationObservations
        );
      });
      observeConsultationOperations(bot, sessionId, consultationObservations);
    } catch (error) {
      logChatObservation("chat.persistence", {
        botSlug: bot.slug,
        durationMs: Date.now() - startedAt,
        errorCode: errorCodeOf(error),
        firstLine: rows[0]?.line ?? null,
        lastLine: rows.at(-1)?.line ?? null,
        nextLine,
        outcome: hasConsultationOpen ? "consultation_failed" : "failed",
        rowCount: rows.length,
        sessionId,
      });
      throw error;
    }
  };
}

/** Brings the bot's chat into Postgres, independent of any open app (spec 4.3). */
export async function syncBot(bot: BotRow): Promise<void> {
  if (!bot.sessionId) {
    return;
  }
  await syncBotSession(bot, bot.sessionId);
}

/**
 * One of the bot's main sessions, current or archived: a delivery is followed in the session that
 * admitted it. A bounded read works on an ended or stranded session too (eve keeps its history).
 */
export async function syncBotSession(
  bot: BotRow,
  sessionId: string
): Promise<void> {
  await syncSession(
    {
      read: (start) => readStream(botCall(bot.slug), sessionId, start, false),
      save: saver(bot, sessionId, true),
    },
    await cursorOf(sessionId)
  );
}

export async function syncConsultation(
  c: typeof consultations.$inferSelect
): Promise<void> {
  if (!c.childSessionId) {
    return;
  }
  const people = await db()
    .select()
    .from(bots)
    .where(inArray(bots.id, [c.fromBotId, ...(c.toBotId ? [c.toBotId] : [])]));
  const from = people.find((bot) => bot.id === c.fromBotId);
  const to = c.toBotId ? people.find((bot) => bot.id === c.toBotId) : undefined;
  if (!from) {
    return;
  }
  const path = childStreamPath(c.parentSessionId, c.callId, c.childSessionId);
  await syncSession(
    {
      read: (start) => readStreamAt(botCall(from.slug), path, start, false),
      save: saver(from, c.childSessionId, false, to?.billing ?? null),
    },
    await cursorOf(c.childSessionId)
  );
}
