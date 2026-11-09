import type { ClientRow } from "./items";

/**
 * Where the session's newest turn stands, from its facts (H-33):
 * - `running`: a turn started and shows no pause. It becomes `unknown` after `staleMs` without a
 *   fact of its own, and only when the facts carry their time. Unknown is not dead: a watchdog
 *   re-syncs, and only `session.ended` releases it.
 * - `awaiting_input`: the turn paused on a question, approval or sign-in (`turn.paused`). A person
 *   may answer hours later, so it never goes stale.
 * - `ended`: eve ended the session (`session.ended`); nothing in it runs any more.
 * - `idle`: no open turn.
 * `pendingDeliveries` counts messages eve admitted and hasn't settled: their turn may not have
 * started yet. The projection never invents a `turn.settled`.
 */
export type TurnState =
  | "idle"
  | "running"
  | "awaiting_input"
  | "unknown"
  | "ended";

export interface TurnProjection {
  lastProgressAt: Date | null;
  pendingDeliveries: number;
  startedAt: Date | null;
  state: TurnState;
  turnId: string | null;
}

export interface TurnFact {
  at?: Date | null;
  data: { data?: Record<string, unknown>; scope?: Record<string, unknown> };
  type: string;
}

/** A running turn without a fact of its own for this long is `unknown`: open, but not verified. */
export const STALE_TURN_MS = 15 * 60_000;

// Facts about a paused turn's waiting itself, not about it running again.
const WAITING_FACTS = new Set([
  "interaction.opened",
  "interaction.settled",
  "response.submitted",
  "response.settled",
  "turn.paused",
]);

const idOf = (fact: TurnFact, key: string): string | null => {
  const value = fact.data.data?.[key] ?? fact.data.scope?.[key];
  return typeof value === "string" ? value : null;
};

interface OpenTurn {
  last: Date | null;
  paused: boolean;
  startedAt: Date | null;
  turnId: string | null;
}

function step(open: OpenTurn | null, fact: TurnFact): OpenTurn | null {
  const at = fact.at ?? null;
  if (fact.type === "turn.started") {
    return {
      last: at,
      paused: false,
      startedAt: at,
      turnId: idOf(fact, "turnId"),
    };
  }
  if (!open) {
    return null;
  }
  const turnId = idOf(fact, "turnId");
  // A fast ack's turn never settles itself: it stays open for eve's turn (fastAckRows), and its
  // slot can sort after eve's turn.started. eve's facts then belong to it, settle included.
  const ours =
    turnId === null ||
    open.turnId === null ||
    turnId === open.turnId ||
    open.turnId.startsWith("fast-");
  if (!ours) {
    return open;
  }
  if (fact.type === "turn.settled") {
    return null;
  }
  if (fact.type === "turn.paused") {
    return { ...open, last: at ?? open.last, paused: true };
  }
  // A fact outside any turn (a delivery, a session fact) says nothing about this one.
  if (turnId === null) {
    return open;
  }
  if (WAITING_FACTS.has(fact.type)) {
    return { ...open, last: at ?? open.last };
  }
  // eve announces no resume: the next fact under the turn shows it runs again.
  return { ...open, last: at ?? open.last, paused: false };
}

/** Projects the newest turn from a session's facts in stream order (see {@link TurnState}). */
export function projectTurn(
  facts: readonly TurnFact[],
  now?: number,
  staleMs = STALE_TURN_MS
): TurnProjection {
  let open: OpenTurn | null = null;
  const pending = new Set<string>();
  for (const fact of facts) {
    if (fact.type === "session.ended") {
      return {
        lastProgressAt: fact.at ?? null,
        pendingDeliveries: 0,
        startedAt: null,
        state: "ended",
        turnId: null,
      };
    }
    const deliveryId = idOf(fact, "deliveryId");
    if (fact.type === "delivery.admitted" && deliveryId) {
      pending.add(deliveryId);
    } else if (fact.type === "delivery.settled" && deliveryId) {
      pending.delete(deliveryId);
    }
    open = step(open, fact);
  }
  if (!open) {
    return {
      lastProgressAt: null,
      pendingDeliveries: pending.size,
      startedAt: null,
      state: "idle",
      turnId: null,
    };
  }
  let state: TurnState = open.paused ? "awaiting_input" : "running";
  if (
    state === "running" &&
    now !== undefined &&
    open.last &&
    now - open.last.getTime() > staleMs
  ) {
    state = "unknown";
  }
  return {
    lastProgressAt: open.last,
    pendingDeliveries: pending.size,
    startedAt: open.startedAt,
    state,
    turnId: open.turnId,
  };
}

/** A turn may still use the bot: running, waiting for a person, or not verified as gone. */
export const turnOpen = (p: Pick<TurnProjection, "state">): boolean =>
  p.state === "running" ||
  p.state === "awaiting_input" ||
  p.state === "unknown";

/** A turn started and hasn't settled, and its session hasn't ended. */
export function isWorking(rows: readonly ClientRow[]): boolean {
  return turnOpen(projectTurn(rows));
}

const PEER_CALL = /^peer-(?<slot>\d+)$/u;

/**
 * This message is done. eve ends every delivery with exactly one `delivery.settled`, after the turn
 * that took it settles; a message sent mid-turn is admitted at once but taken by its own queued turn,
 * so the running turn's settle must not count. A later turn belongs to another message.
 */
export function deliverySettled(
  rows: readonly ClientRow[],
  deliveryId: string
): boolean {
  return rows.some(
    (r) =>
      r.type === "delivery.settled" && r.data.data.deliveryId === deliveryId
  );
}

/** Consultations this bot's turn is waiting on: callId → directory slot of each unsettled `peer-N` call. */
export function openPeerCalls(rows: readonly ClientRow[]): Map<string, number> {
  const open = new Map<string, number>();
  for (const r of rows) {
    const d = r.data.data ?? {};
    if (r.type === "call.requested") {
      const m = PEER_CALL.exec(
        String((d.capability as { name?: string } | undefined)?.name ?? "")
      );
      if (m) {
        open.set(String(d.callId), Number(m.groups?.slot));
      }
    } else if (r.type === "call.settled") {
      open.delete(String(d.callId));
    } else if (r.type === "turn.settled") {
      open.clear();
    }
  }
  return open;
}

export type WaitStage = "sending" | "received" | "admitted" | "thinking";

/**
 * Where the newest message is before the reply shows anything: still posting, acknowledged,
 * admitted by the bot, or in a running turn. The first text delta hides the status line itself.
 */
export function waitStage(
  rows: readonly ClientRow[],
  pending: readonly { deliveryId?: string; failed?: boolean; id: string }[],
  working: boolean
): { id: string; stage: WaitStage } | null {
  const p = pending.findLast((item) => !item.failed);
  if (working) {
    return { id: p?.id ?? "turn", stage: "thinking" };
  }
  if (!p) {
    return null;
  }
  if (!p.deliveryId) {
    return { id: p.id, stage: "sending" };
  }
  const admitted = rows.some(
    (r) =>
      r.type === "delivery.admitted" && r.data.data?.deliveryId === p.deliveryId
  );
  return { id: p.id, stage: admitted ? "admitted" : "received" };
}
