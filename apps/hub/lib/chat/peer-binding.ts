import { and, asc, inArray, isNull, ne } from "drizzle-orm";
import { type BotRow, bots, consultations, db } from "../db";
import { childStreamPath, readStreamAt } from "../eve/client";
import { botCall } from "./store";
import { peerWindow } from "./sync";

// H-24: which bot did a `peer-N` consultation really go to? The asking bot's `child.opened`
// names only the slot, and the directory can change between its pick and the hub's sync.

/** eve session ids on Vercel are workflow run ids: `wrun_` + a 26-character ULID. */
const EVE_SESSION_ID = /^wrun_[0-9A-HJKMNP-TV-Z]{26}$/u;
export const isEveSessionId = (value: unknown): value is string =>
  typeof value === "string" && EVE_SESSION_ID.test(value);

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** principalId of a hub-signed consultation: busy-hub:consultation:<fromBotId>:<toBotId>. */
const CONSULTATION_PRINCIPAL =
  /^busy-hub:consultation:(?<from>[0-9a-f-]{36}):(?<to>[0-9a-f-]{36})$/u;

export interface PeerCandidate {
  id: string;
  slug: string;
}

/**
 * Every other bot in the directory's total order (created_at, id), split into the current
 * `peer-N` window (ready bots, newest PEER_SLOTS, as /api/bot/directory and the bot's pickPeer)
 * and the rest. One read per save batch.
 */
export async function peerDirectory(
  from: Pick<BotRow, "id">
): Promise<{ others: PeerCandidate[]; window: PeerCandidate[] }> {
  const rows = await db()
    .select({ id: bots.id, slug: bots.slug, status: bots.status })
    .from(bots)
    .where(and(ne(bots.id, from.id), isNull(bots.deletionState)))
    .orderBy(asc(bots.createdAt), asc(bots.id));
  const window = peerWindow(rows.filter((row) => row.status === "ready")).map(
    ({ id, slug }) => ({ id, slug })
  );
  const inWindow = new Set(window.map(({ id }) => id));
  const others = rows
    .filter(({ id }) => !inWindow.has(id))
    .map(({ id, slug }) => ({ id, slug }));
  return { others, window };
}

export interface PeerBindingDeps {
  /** Does this one candidate's deployment hold exactly this child session? */
  confirm: (peer: PeerCandidate, childSessionId: string) => Promise<boolean>;
  /**
   * The consulted bot id recorded at dispatch: the child's admitted principal, which the
   * consulted bot built from a hub-signed credential for this asking bot and that peer.
   * null when the consultation used the legacy OIDC credential.
   */
  recordedTarget: (
    from: Pick<BotRow, "id" | "slug">,
    parentSessionId: string,
    callId: string,
    childSessionId: string
  ) => Promise<string | null>;
}

const PROBE_TIMEOUT_MS = 3000;
const STREAM_LINES_FOR_PRINCIPAL = 8;

/**
 * Confirms one candidate: eve's stream route with includeTailIndex resolves the session before
 * answering (a missing one is a 404), and the response must name that same session.
 */
export async function confirmChildSession(
  peer: PeerCandidate,
  childSessionId: string
): Promise<boolean> {
  if (!isEveSessionId(childSessionId)) {
    return false;
  }
  try {
    const target = botCall(peer.slug);
    const qs = new URLSearchParams({ includeTailIndex: "1", startIndex: "0" });
    const res = await (target.fetchImpl ?? fetch)(
      `${target.url}/eve/v1/session/${childSessionId}/stream?${qs}`,
      {
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${await target.token()}`,
          ...(target.headers ?? {}),
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }
    );
    res.body?.cancel().catch(() => undefined);
    return res.ok && res.headers.get("x-eve-session-id") === childSessionId;
  } catch {
    return false;
  }
}

/** Reads the child's first lines through the asking bot (the thread view's own route). */
export async function recordedTargetFromChild(
  from: Pick<BotRow, "id" | "slug">,
  parentSessionId: string,
  callId: string,
  childSessionId: string
): Promise<string | null> {
  if (!isEveSessionId(childSessionId)) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    let lines = 0;
    for await (const { record } of readStreamAt(
      botCall(from.slug),
      childStreamPath(parentSessionId, callId, childSessionId),
      0,
      false,
      controller.signal
    )) {
      for (const fact of (record.facts as
        | { data?: { principal?: { id?: unknown } }; type?: string }[]
        | undefined) ?? []) {
        if (fact.type !== "delivery.admitted") {
          continue;
        }
        const match = CONSULTATION_PRINCIPAL.exec(
          String(fact.data?.principal?.id ?? "")
        )?.groups;
        // The first admitted delivery decides: a hub credential for this asking bot, or none.
        return match?.from === from.id && UUID.test(match.to ?? "")
          ? (match.to ?? null)
          : null;
      }
      lines += 1;
      if (lines >= STREAM_LINES_FOR_PRINCIPAL) {
        break;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export const defaultPeerBinding: PeerBindingDeps = {
  confirm: confirmChildSession,
  recordedTarget: recordedTargetFromChild,
};

export interface ConsultationOpen {
  callId: string;
  childSessionId: string;
  slot: number;
}
export type PeerBindingReason =
  | "already_recorded"
  | "budget_exhausted"
  | "peer_unverified";
export interface PeerBinding {
  reason?: PeerBindingReason;
  toBotId: string | null;
}

/** At most this many consultations are attributed per save batch, within this deadline. */
export const MAX_BINDINGS_PER_BATCH = 8;
const BATCH_DEADLINE_MS = 10_000;

/**
 * Binds each opened consultation to one candidate, never to "whoever answers":
 * - the target recorded at dispatch (hub-signed credential), checked against the directory;
 * - legacy credential: only the bot the slot names now.
 * That single candidate's deployment must then confirm the exact child session. Anything else
 * (deleted bot, shifted slot, unreachable, budget spent) stays unattributed with a reason.
 * Runs before the save transaction: no HTTP while events/cursor rows are being written.
 */
export async function bindConsultationPeers(
  from: Pick<BotRow, "id" | "slug">,
  parentSessionId: string,
  opens: ConsultationOpen[],
  deps: PeerBindingDeps = defaultPeerBinding,
  now: () => number = Date.now
): Promise<Map<string, PeerBinding>> {
  const result = new Map<string, PeerBinding>();
  if (opens.length === 0) {
    return result;
  }
  const known = await db()
    .select({ callId: consultations.callId })
    .from(consultations)
    .where(
      inArray(
        consultations.callId,
        opens.map(({ callId }) => callId)
      )
    );
  const recorded = new Set(known.map(({ callId }) => callId));
  const directory = await peerDirectory(from);
  const everyone = new Map(
    [...directory.window, ...directory.others].map((peer) => [peer.id, peer])
  );
  const deadline = now() + BATCH_DEADLINE_MS;
  let attempts = 0;
  for (const open of opens) {
    if (recorded.has(open.callId)) {
      // Already persisted (insert is a no-op): never probe again.
      result.set(open.callId, { reason: "already_recorded", toBotId: null });
      continue;
    }
    if (attempts >= MAX_BINDINGS_PER_BATCH || now() >= deadline) {
      result.set(open.callId, { reason: "budget_exhausted", toBotId: null });
      continue;
    }
    attempts += 1;
    // biome-ignore lint/performance/noAwaitInLoops: bounded, sequential, and stops at the deadline
    const recordedId = await deps.recordedTarget(
      from,
      parentSessionId,
      open.callId,
      open.childSessionId
    );
    const candidate = recordedId
      ? everyone.get(recordedId)
      : directory.window[open.slot - 1];
    const confirmed =
      candidate !== undefined &&
      now() < deadline &&
      (await deps.confirm(candidate, open.childSessionId));
    result.set(
      open.callId,
      confirmed && candidate
        ? { toBotId: candidate.id }
        : { reason: "peer_unverified", toBotId: null }
    );
  }
  return result;
}
