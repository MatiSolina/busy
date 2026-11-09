import type { StreamRecord } from "../eve/client";

export interface Fact {
  data: Record<string, unknown>;
  scope?: Record<string, unknown>;
  type: string;
}
export interface EventRow {
  at: Date;
  data: Fact;
  index: number;
  line: number;
  type: string;
}

export interface SyncDeps {
  read: (startIndex: number) => AsyncIterable<StreamRecord>;
  // Persists one stored line's facts and advances the cursor past it, atomically.
  save: (rows: EventRow[], nextLine: number) => Promise<void>;
}

const PEER_FACT = /^peer-(?<slot>\d+)$/u;

/** A bot has 12 `peer-N` slots (templates/bot/agent/lib/peers.ts): they hold the newest peers. */
export const PEER_SLOTS = 12;
/** The peers in slots 1..12 of an oldest-first directory, as the bot's `pickPeer` picks them. */
export const peerWindow = <T>(oldestFirst: readonly T[]): T[] =>
  oldestFirst.slice(Math.max(0, oldestFirst.length - PEER_SLOTS));

/**
 * Copies a session's stored stream into the events table from `cursor` on and
 * returns the next line. Progress records (deltas) hold a position but no state,
 * so they advance the cursor without rows. Safe to rerun: rows key on (line, index).
 */
export async function syncSession(
  deps: SyncDeps,
  cursor: number
): Promise<number> {
  let next = cursor;
  for await (const { line, record } of deps.read(cursor)) {
    const facts = (record.facts as Fact[] | undefined) ?? [];
    const at = record.at ? new Date(String(record.at)) : new Date();
    await deps.save(
      facts.map((fact, index) => ({
        at,
        data: fact,
        index,
        line,
        type: fact.type,
      })),
      line + 1
    );
    next = line + 1;
  }
  return next;
}

/** A consultation is a `child.opened` of a `peer-N` remote agent (plan task 4). */
export function consultationFromFact(fact: {
  type: string;
  data: Record<string, unknown>;
}): { callId: string; childSessionId: string; slot: number } | null {
  if (fact.type !== "child.opened") {
    return null;
  }
  const m = PEER_FACT.exec(String(fact.data.name));
  const callId = (fact.data.owner as { callId?: string } | undefined)?.callId;
  if (!(m && callId) || typeof fact.data.sessionId !== "string") {
    return null;
  }
  return {
    callId,
    childSessionId: fact.data.sessionId,
    slot: Number(m.groups?.slot),
  };
}
