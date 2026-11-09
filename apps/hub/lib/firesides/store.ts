import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { getAiSettings } from "../ai/settings";
import { toChatView } from "../chat/items";
import { recentHistory } from "../chat/send";
import type { BotRow } from "../db";
import {
  bots,
  db,
  firesideCommands,
  firesideRunners,
  firesides,
  memories,
} from "../db";
import { requireFiresideRuntime } from "./compatibility";
import { wakeRunner } from "./runner";
import { chooseGuest } from "./selection";
import { applyCommand, FiresideConflict } from "./state";
import type {
  FiresideCommand,
  FiresideState,
  FiresideView,
  Participant,
} from "./types";

const ACTIVE = ["running", "waiting", "paused", "closing"] as const;
export async function getFireside(id: string) {
  const [row] = await db().select().from(firesides).where(eq(firesides.id, id));
  return row ?? null;
}

export function updateFireside(
  id: string,
  change: (state: FiresideState) => void,
  token?: string
) {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(firesides)
      .where(eq(firesides.id, id))
      .for("update");
    if (!row || (token && row.leaseToken !== token)) {
      return null;
    }
    change(row.state);
    const [saved] = await tx
      .update(firesides)
      .set({
        state: row.state,
        status: row.state.status,
        updatedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(firesides.id, id))
      .returning();
    return saved;
  });
}

export async function createFireside(primary: BotRow, originId: string) {
  const existing = await db()
    .select()
    .from(firesides)
    .where(
      or(
        eq(firesides.originId, originId),
        and(
          eq(firesides.botId, primary.id),
          inArray(firesides.status, [...ACTIVE])
        )
      )
    );
  const priorOrigin = existing.find((row) => row.originId === originId);
  if (priorOrigin && priorOrigin.botId !== primary.id) {
    throw new FiresideConflict("This request belongs to another conversation.");
  }
  if (priorOrigin ?? existing[0]) {
    return priorOrigin ?? existing[0];
  }
  const [peers, settings, context, memory] = await Promise.all([
    db()
      .select()
      .from(bots)
      .where(eq(bots.status, "ready"))
      .orderBy(asc(bots.createdAt)),
    getAiSettings(),
    recentHistory(primary),
    db().select().from(memories),
  ]);
  const choice = chooseGuest(primary, peers, settings);
  if (!choice) {
    throw new FiresideConflict(
      "Connect another available model to ask for a second opinion."
    );
  }
  await Promise.all(
    [...new Set([primary.slug, choice.bot?.slug ?? primary.slug])].map(
      requireFiresideRuntime
    )
  );
  const participant = (base: BotRow, temporary = false): Participant => ({
    allocating: false,
    avatar: base.avatar,
    billing: base.billing,
    botId: base.id,
    cursor: 0,
    generation: 0,
    id: randomUUID(),
    memory: memory.find((m) => m.botSlug === base.slug)?.content ?? "",
    memoryVersion: 0,
    model: base.model,
    name: base.name,
    sessionId: null,
    slug: base.slug,
    temporary,
  });
  const guest = participant(choice.bot ?? primary, !choice.bot);
  guest.model = choice.model;
  guest.billing = choice.billing;
  guest.name = choice.name;
  const state: FiresideState = {
    active: null,
    cancelSessions: [],
    context,
    error: null,
    lastSpeaker: "primary",
    messages: [],
    participants: { guest, primary: participant(primary) },
    remaining: { guest: 1, primary: 1 },
    revision: 1,
    status: "running",
    summary: null,
    summaryVersion: 0,
  };
  return db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`fireside:${primary.id}`}))`
    );
    const [duplicate] = await tx
      .select()
      .from(firesides)
      .where(eq(firesides.originId, originId));
    if (duplicate) {
      if (duplicate.botId !== primary.id) {
        throw new FiresideConflict(
          "This request belongs to another conversation."
        );
      }
      return duplicate;
    }
    const [active] = await tx
      .select()
      .from(firesides)
      .where(
        and(
          eq(firesides.botId, primary.id),
          inArray(firesides.status, [...ACTIVE])
        )
      );
    if (active) {
      return active;
    }
    const [row] = await tx
      .insert(firesides)
      .values({
        botId: primary.id,
        id: randomUUID(),
        originId,
        parentSessionId: primary.sessionId,
        state,
        status: state.status,
      })
      .returning();
    await wakeRunner(tx, row.id);
    return row;
  });
}

export function commandFireside(id: string, command: FiresideCommand) {
  return db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(firesides)
      .where(eq(firesides.id, id))
      .for("update");
    if (!row) {
      return null;
    }
    const [previous] = await tx
      .select()
      .from(firesideCommands)
      .where(eq(firesideCommands.id, command.id));
    if (previous) {
      if (
        previous.firesideId !== id ||
        Object.entries(command).some(
          ([key, value]) => previous.payload[key] !== value
        )
      ) {
        throw new FiresideConflict("This request id was already used.");
      }
      return row;
    }
    if (row.state.messages.length >= 500 && command.kind !== "close") {
      throw new FiresideConflict(
        "Start a new fireside to continue this discussion."
      );
    }
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`fireside:${row.botId}`}))`
    );
    if (row.status === "closed" && command.kind !== "close") {
      const [active] = await tx
        .select({ id: firesides.id })
        .from(firesides)
        .where(
          and(
            eq(firesides.botId, row.botId),
            inArray(firesides.status, [...ACTIVE])
          )
        );
      if (active) {
        throw new FiresideConflict(
          "Another fireside is open. Close it before continuing this one."
        );
      }
    }
    applyCommand(row.state, command);
    await tx
      .insert(firesideCommands)
      .values({ firesideId: id, id: command.id, payload: { ...command } });
    // The runner sees this command even if it is about to go idle (H-32).
    await wakeRunner(tx, id);
    const [saved] = await tx
      .update(firesides)
      .set({
        state: row.state,
        status: row.state.status,
        updatedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(firesides.id, id))
      .returning();
    return saved;
  });
}

export async function claimFireside(id: string) {
  const token = randomUUID();
  const now = new Date();
  const [row] = await db()
    .update(firesides)
    .set({ leaseToken: token, leaseUntil: new Date(now.getTime() + 90_000) })
    .where(
      and(
        eq(firesides.id, id),
        or(isNull(firesides.leaseUntil), lt(firesides.leaseUntil, now))
      )
    )
    .returning();
  return row ? { row, token } : null;
}
export async function releaseFireside(id: string, token: string) {
  await db()
    .update(firesides)
    .set({ leaseToken: null, leaseUntil: null })
    .where(and(eq(firesides.id, id), eq(firesides.leaseToken, token)));
}
export function listFiresides(botId: string) {
  return db()
    .select()
    .from(firesides)
    .where(eq(firesides.botId, botId))
    .orderBy(desc(firesides.createdAt))
    .limit(30);
}
/**
 * Firesides with work and no live runner (H-32): none yet, idle, never started, or a lease that
 * expired without heartbeats. A `waiting` or idle `paused` room needs no runner and is left alone;
 * it is never closed by age.
 */
export function pendingFiresides() {
  return db()
    .select({ id: firesides.id })
    .from(firesides)
    .leftJoin(firesideRunners, eq(firesideRunners.firesideId, firesides.id))
    .where(
      and(
        or(
          inArray(firesides.status, ["running", "closing"]),
          and(
            eq(firesides.status, "paused"),
            sql`(jsonb_array_length(${firesides.state}->'cancelSessions') > 0 or ${firesides.state}->'participants'->'primary'->>'allocating' = 'true' or ${firesides.state}->'participants'->'guest'->>'allocating' = 'true')`
          )
        ),
        or(
          isNull(firesideRunners.firesideId),
          inArray(firesideRunners.status, ["idle", "starting"]),
          isNull(firesideRunners.leaseUntil),
          lt(firesideRunners.leaseUntil, sql`now()`)
        )
      )
    )
    .limit(40);
}
async function readFiresideContext(botId: string) {
  const rows = await db()
    .select({ id: firesides.id, state: firesides.state })
    .from(firesides)
    .where(
      and(
        eq(firesides.botId, botId),
        inArray(firesides.status, ["closed", "closing"])
      )
    )
    .orderBy(desc(firesides.updatedAt))
    .limit(3);
  return rows.map((r) => ({
    id: r.id,
    summary: r.state.summary?.slice(0, 8000),
    version: r.state.summaryVersion,
  }));
}

/** The additive feature may deploy before its migration; ordinary chat must still send. */
export async function firesideContext(botId: string) {
  try {
    return await readFiresideContext(botId);
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "42P01"
    ) {
      return [];
    }
    throw error;
  }
}

export function publicFireside(
  row: NonNullable<Awaited<ReturnType<typeof getFireside>>>
): FiresideView {
  const { state } = row;
  const publicParticipant = (p: Participant) => ({
    avatar: p.avatar,
    billing: p.billing,
    id: p.id,
    model: p.model,
    name: p.name,
    slug: p.slug,
  });
  let active: FiresideView["active"] = null;
  if (state.active) {
    const view = toChatView(
      state.active.rows,
      new Map(Object.entries(state.active.deltas)),
      new Map(),
      () => undefined,
      state.participants[state.active.participant].billing
    );
    active = {
      items: view.items.filter((item) => item.kind !== "user"),
      messageId: state.active.messageId,
      speaker: state.active.participant,
    };
  }
  return {
    active,
    createdAt: row.createdAt.toISOString(),
    error: state.error,
    id: row.id,
    messages: state.messages.map((message) => ({
      at: message.at,
      id: message.id,
      interrupted: message.interrupted,
      items: message.items,
      speaker: message.speaker,
      text: message.text,
    })),
    participants: {
      guest: publicParticipant(state.participants.guest),
      primary: publicParticipant(state.participants.primary),
    },
    primarySlug: state.participants.primary.slug,
    revision: state.revision,
    status: state.status,
    summary: state.summary,
  };
}
