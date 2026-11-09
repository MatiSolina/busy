import {
  type AiIssue,
  aiIssue,
  aiIssueFromResponse,
  issueFromProviderStatus,
} from "../ai/errors";
import type { Billing } from "../bots/models";
import type { DeployStep } from "../bots/progress";
import type { ChatRum } from "../rum/client";
import type { ClientRow } from "./items";
import { isWorking, openPeerCalls } from "./status";
import { peerWindow } from "./sync";

export type BotStatus = "creating" | "deploying" | "ready" | "failed";
export interface BotLite {
  avatar: string | null;
  billing: Billing;
  description: string;
  error: string | null;
  fast: boolean;
  /** Absent until the edit form asks for it: the chat never shows it. */
  instructions?: string;
  model: string;
  name: string;
  /** The deploy's steps while it isn't ready; only the bot poll (GET /api/bots/[slug]) sends them. */
  progress?: DeployStep[] | null;
  slug: string;
  status: BotStatus;
}
export interface ConsultLite {
  callId: string;
  id: string;
  peerName: string;
  peerSlug: string | null;
}
/** A chat session eve replaced: shown above the current one, read-only. */
export interface PastSession {
  historyCursor?: HistoryCursor | null;
  historyHasMore?: boolean;
  rows: ClientRow[];
  sessionId: string;
}
export interface PastCursor {
  sessionId: string;
  startedAt: string;
}
export interface HistoryCursor {
  index: number;
  line: number;
}
export type InitialBotLite = BotLite & {
  rows: ClientRow[];
  consults: ConsultLite[];
  resumeAfter?: number | null;
  sessionId: string | null;
  historyCursor?: HistoryCursor | null;
  historyHasMore?: boolean;
  past: PastSession[];
  pastCursor?: PastCursor | null;
  pastHasMore?: boolean;
  pastLoaded?: boolean;
  snapshotLoaded?: boolean;
};

export interface Pending {
  deliveryId?: string;
  /** Legacy transport text; structured `issue` is preferred for new failures. */
  error?: string;
  failed?: boolean;
  /** File ids are retained so an explicit retry can use the original uploads. */
  fileIds?: string[];
  files: string[];
  id: string;
  issue?: AiIssue;
  text: string;
  timeZone?: string;
  /**
   * The fast-path response was cut before its final line: the hub may still have delivered it. Not
   * a failure; one reconciling POST with the same id finds out (H-22).
   */
  uncertain?: boolean;
}

/** Drops the pending messages whose `delivery.consumed` is among these rows, and only those. */
export function settledBy(
  pending: Pending[],
  rows: readonly ClientRow[]
): Pending[] {
  const consumed = new Set(
    rows
      .filter((row) => row.type === "delivery.consumed")
      .map((row) => String(row.data.data?.deliveryId))
  );
  if (!consumed.size) {
    return pending;
  }
  const kept = pending.filter(
    (p) => !(p.deliveryId && consumed.has(p.deliveryId))
  );
  return kept.length === pending.length ? pending : kept;
}

export interface BotState {
  bot: BotLite;
  consults: Map<string, { id: string; peerName: string }>;
  deltas: Map<string, string>;
  historyCursor: HistoryCursor | null;
  historyHasMore: boolean;
  historyStatus: "idle" | "loading" | "ready" | "error";
  lastLine: number;
  past: PastSession[];
  pastCursor: PastCursor | null;
  pastHasMore: boolean;
  pastStatus: "idle" | "loading" | "ready" | "error";
  pending: Pending[];
  rows: ClientRow[];
  sessionId: string | null;
  snapshotStatus: "idle" | "loading" | "ready" | "error";
  /** What the bot said it is about to do (fast path escalation), until its turn settles. */
  status?: string | null;
}

export interface ChatState {
  bots: Record<string, BotState>;
  order: string[];
  selected: string | null;
}

/**
 * Who `slug` is answering right now: another bot whose turn waits on a `peer-N` call to it.
 * The consultation runs in its own session, so `slug`'s rows never show it. Slots follow the
 * asker's directory (other ready bots, oldest first, newest 12), as the bot's pickPeer does.
 */
export function consultedBy(
  state: ChatState,
  slug: string
): { from: string; callId: string } | null {
  for (const from of state.order) {
    if (from === slug) {
      continue;
    }
    const directory = peerWindow(
      state.order.filter(
        (o) => o !== from && state.bots[o]?.bot.status === "ready"
      )
    );
    for (const [callId, slot] of openPeerCalls(state.bots[from]?.rows)) {
      if (directory[slot - 1] === slug) {
        return { callId, from };
      }
    }
  }
  return null;
}

const WARM_EVERY_MS = 120_000;

// open is lazy: the store is created during SSR, where EventSource doesn't exist.
interface Deps {
  fetch: typeof fetch;
  open: (url: string) => EventSource;
  rum?: ChatRum;
}

const PUBLIC_ISSUE_CODES = new Set([
  "access_denied",
  "attempt_not_found",
  "chatgpt_desktop_required",
  "connection_failed",
  "connection_expired",
  "connection_not_connected",
  "context_length_exceeded",
  "could_not_cancel",
  "could_not_disconnect",
  "could_not_load",
  "could_not_save",
  "could_not_start_connection",
  "gateway_unavailable",
  "inference_failed",
  "invalid_callback",
  "invalid_data",
  "invalid_inference_input",
  "invalid_model",
  "invalid_redirect_uri",
  "message_delivery_failed",
  "model_unavailable",
  "not_found",
  "payload_too_large",
  "pending",
  "provider_access_denied",
  "provider_auth_failed",
  "provider_not_found",
  "provider_quota_exceeded",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_unconfigured",
  "subscription_model_unavailable",
  "subscription_not_selected",
  "subscription_request_failed",
  "unauthorized",
]);

const keyOf = (r: ClientRow) => `${r.line}:${r.index}`;

function toBotState({
  rows,
  consults,
  resumeAfter = null,
  sessionId,
  historyCursor = null,
  historyHasMore = false,
  past,
  pastLoaded = true,
  pastCursor = null,
  pastHasMore = !pastLoaded,
  snapshotLoaded = true,
  ...bot
}: InitialBotLite): BotState {
  return {
    bot,
    consults: new Map(
      consults.map((c) => [c.callId, { id: c.id, peerName: c.peerName }])
    ),
    deltas: new Map(),
    historyCursor,
    historyHasMore,
    historyStatus: historyHasMore ? "idle" : "ready",
    lastLine:
      resumeAfter === null
        ? rows.reduce((m, r) => Math.max(m, r.line), -1)
        : Math.max(-1, resumeAfter - 1),
    past,
    pastCursor,
    pastHasMore,
    pastStatus: pastLoaded ? "ready" : "idle",
    pending: [],
    rows,
    sessionId,
    snapshotStatus: snapshotLoaded ? "ready" : "idle",
  };
}

/**
 * Client state for every bot, kept in memory so switching is a state change, not a request
 * (spec 7, "UI"). A ready bot has a live SSE stream while it is on screen or working; idle
 * bots in the background close theirs and catch up from their last line when shown again.
 */
export function createChatStore(
  initial: InitialBotLite[],
  deps: Deps,
  selected?: string
) {
  let state: ChatState = {
    bots: Object.fromEntries(initial.map((b) => [b.slug, toBotState(b)])),
    order: initial.map((b) => b.slug),
    selected:
      selected && initial.some((b) => b.slug === selected)
        ? selected
        : (initial[0]?.slug ?? null),
  };
  const warmedAt = new Map<string, number>();
  // A deferred boundary may hydrate after live events have already arrived.
  // Its server snapshot must still describe the HTML originally sent.
  const serverState = state;
  const listeners = new Set<() => void>();
  const streams = new Map<string, EventSource>();
  const streamGeneration = new Map<string, number>();
  const followedStreams = new Set<string>();
  // A session announcement from SSE is followed by a bounded snapshot once
  // that stream closes. A snapshot response that already carried the rotated
  // session clears this marker and does not issue a second request.
  const snapshotAfterRotation = new Set<string>();
  const snapshotReconnectPending = new Set<string>();
  // Progress is replayed from the persisted fact cursor after reconnecting.
  // Retain its own high-water mark without advancing that durable cursor.
  const progressLines = new Map<
    string,
    { sessionId: string | null; line: number }
  >();
  let streamsActive = true;
  // First delta's kind per part. Keyed by bot and session too: eve restarts part ids ("run_0.0") in every session.
  const kinds = new Map<string, string>();

  const set = (next: ChatState) => {
    state = next;
    for (const l of listeners) {
      l();
    }
  };
  const patchBot = (slug: string, fn: (b: BotState) => BotState) => {
    const current = state.bots[slug];
    if (current) {
      const next = fn(current);
      if (next !== current) {
        set({ ...state, bots: { ...state.bots, [slug]: next } });
      }
    }
  };

  const wanted = (slug: string) => {
    const b = state.bots[slug];
    return (
      !!b &&
      (slug === state.selected ||
        b.pending.some((p) => !p.failed) ||
        isWorking(b.rows))
    );
  };
  function release(slug: string) {
    if (wanted(slug)) {
      return;
    }
    streams.get(slug)?.close();
    streams.delete(slug);
    followedStreams.delete(slug);
  }

  /** The fast path's escalation says what the bot is about to do; it shows until the turn settles. */
  function onStatus(slug: string, status: unknown) {
    if (typeof status === "string") {
      patchBot(slug, (b) => ({ ...b, status }));
    }
  }

  function onFact(slug: string, row: ClientRow) {
    patchBot(slug, (b) => {
      if (b.rows.some((r) => keyOf(r) === keyOf(row))) {
        return b;
      }
      const settled = row.type === "turn.settled";
      const delivered =
        row.type === "delivery.consumed"
          ? String(row.data.data.deliveryId)
          : null;
      return {
        ...b,
        deltas: settled ? new Map() : b.deltas,
        lastLine: Math.max(b.lastLine, row.line),
        pending: delivered
          ? b.pending.filter((p) => p.deliveryId !== delivered)
          : b.pending,
        rows: [...b.rows, row],
        status: settled ? null : b.status,
      };
    });
    if (
      row.type === "child.opened" ||
      // Peer calls are `call-…`; their task scope is what says `peer-N-…`.
      (row.type === "call.settled" &&
        String(row.data.scope?.taskId ?? "").startsWith("peer-"))
    ) {
      // The hub records the consultation right after this line; give it a moment.
      setTimeout(() => {
        refreshConsults(slug).catch((error) => {
          console.warn("chat: could not refresh consultations", {
            error,
            slug,
          });
        });
      }, 1500);
    }
    if (row.type === "turn.settled") {
      release(slug);
    }
  }

  function onSession(slug: string, sessionId: string | null) {
    const previous = state.bots[slug];
    const changed = !!previous && previous.sessionId !== sessionId;
    patchBot(slug, (b) => {
      if (b.sessionId === sessionId) {
        return b;
      }
      progressLines.delete(slug);
      // eve replaced the session: the old chat stays above as history and the new one starts empty.
      // A first or empty session archives nothing: keep what was known.
      const archived = !!b.sessionId && b.rows.length > 0;
      const past =
        b.sessionId && archived && b.snapshotStatus === "ready"
          ? [
              ...b.past,
              {
                ...(b.historyHasMore
                  ? {
                      historyCursor: b.historyCursor,
                      historyHasMore: true,
                    }
                  : {}),
                rows: b.rows,
                sessionId: b.sessionId,
              },
            ]
          : b.past;
      return {
        ...b,
        deltas: new Map(),
        historyCursor: null,
        historyHasMore: false,
        historyStatus: "ready",
        lastLine: -1,
        past,
        pastCursor: archived ? null : b.pastCursor,
        pastHasMore: archived || b.pastHasMore,
        pastStatus: archived ? "idle" : b.pastStatus,
        rows: [],
        sessionId,
        // The mismatch response closes the old SSE stream. Its error handler
        // rehydrates a bounded snapshot (including lifecycle context) before
        // reconnecting with the new session's line cursor.
        snapshotStatus: "ready",
      };
    });
    if (changed) {
      snapshotAfterRotation.add(slug);
    }
  }

  function onProgress(
    slug: string,
    p: {
      line?: number;
      type: string;
      data: { partId?: string; delta?: string; kind?: string };
    }
  ) {
    if (p.type !== "content.delta" || !p.data.partId || !p.data.delta) {
      return;
    }
    const { line } = p;
    const sessionId = state.bots[slug]?.sessionId ?? null;
    const previous = progressLines.get(slug);
    const numbered =
      typeof line === "number" && Number.isSafeInteger(line) && line >= 0;
    if (
      numbered &&
      previous?.sessionId === sessionId &&
      line <= previous.line
    ) {
      return;
    }
    const part = p.data.partId;
    const kindKey = `${slug}\u0000${sessionId ?? ""}\u0000${part}`;
    if (p.data.kind && !kinds.has(kindKey)) {
      kinds.set(kindKey, p.data.kind);
    }
    if (kinds.get(kindKey) !== "text") {
      return; // reasoning is never shown
    }
    if (numbered) {
      progressLines.set(slug, { line, sessionId });
    }
    patchBot(slug, (b) => {
      const deltas = new Map(b.deltas);
      deltas.set(part, (deltas.get(part) ?? "") + p.data.delta);
      return { ...b, deltas };
    });
    deps.rum?.firstText(slug);
  }

  function connect(slug: string) {
    const b = state.bots[slug];
    if (
      !streamsActive ||
      b?.bot.status !== "ready" ||
      streams.has(slug) ||
      snapshotReconnectPending.has(slug)
    ) {
      return;
    }
    const generation = (streamGeneration.get(slug) ?? 0) + 1;
    streamGeneration.set(slug, generation);
    const es = deps.open(
      `/api/bots/${encodeURIComponent(slug)}/events?after=${b.lastLine}&session=${encodeURIComponent(b.sessionId ?? "")}`
    );
    streams.set(slug, es);
    followedStreams.add(slug);
    es.addEventListener("session", (e) => {
      if (streams.get(slug) !== es) {
        return;
      }
      onSession(
        slug,
        (JSON.parse((e as MessageEvent).data) as { sessionId: string })
          .sessionId
      );
    });
    es.addEventListener("fact", (e) => {
      if (streams.get(slug) === es) {
        onFact(slug, JSON.parse((e as MessageEvent).data));
      }
    });
    es.addEventListener("progress", (e) => {
      if (streams.get(slug) === es) {
        onProgress(slug, JSON.parse((e as MessageEvent).data));
      }
    });
    // The server ends each stream within 5 minutes; reconnect from the last line we have.
    es.onerror = () => {
      if (streams.get(slug) !== es) {
        return;
      }
      es.close();
      streams.delete(slug);
      const expectedSession = state.bots[slug]?.sessionId ?? null;
      const reconnect = () => {
        const current = state.bots[slug];
        if (
          streamGeneration.get(slug) !== generation ||
          streams.has(slug) ||
          !streamsActive ||
          !wanted(slug) ||
          current?.sessionId !== expectedSession
        ) {
          return;
        }
        connect(slug);
      };
      if (snapshotAfterRotation.has(slug)) {
        snapshotAfterRotation.delete(slug);
        snapshotReconnectPending.add(slug);
        patchBot(slug, (currentBot) => ({
          ...currentBot,
          snapshotStatus: "idle",
        }));
        // A rotated stream must snapshot first. Its explicit resumeAfter is
        // what makes the subsequent SSE replay safe at the final line.
        loadSnapshot(slug, true)
          .then(() => {
            snapshotReconnectPending.delete(slug);
            reconnect();
          })
          .catch(() => {
            snapshotReconnectPending.delete(slug);
            reconnect();
          });
        return;
      }
      // Re-checked when the timer fires: the user may have moved to another bot within the second.
      setTimeout(reconnect, 1000);
    };
  }

  async function refreshConsults(slug: string) {
    const res = await deps.fetch(
      `/api/bots/${encodeURIComponent(slug)}/consultations`
    );
    if (!res.ok) {
      return;
    }
    const list = (await res.json()) as ConsultLite[];
    patchBot(slug, (b) => ({
      ...b,
      consults: new Map(
        list.map((c) => [c.callId, { id: c.id, peerName: c.peerName }])
      ),
    }));
  }

  async function loadSnapshot(slug: string, force = false) {
    const before = state.bots[slug];
    if (
      !before ||
      before.snapshotStatus === "ready" ||
      before.snapshotStatus === "loading" ||
      (snapshotReconnectPending.has(slug) && !force)
    ) {
      return;
    }
    patchBot(slug, (b) => ({ ...b, snapshotStatus: "loading" }));
    try {
      const response = await deps.fetch(
        `/api/bots/${encodeURIComponent(slug)}/snapshot`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error("Conversation unavailable");
      }
      const body = (await response.json()) as {
        historyCursor?: HistoryCursor | null;
        historyHasMore?: boolean;
        resumeAfter?: number;
        rows: ClientRow[];
        consults: ConsultLite[];
        sessionId: string | null;
      };
      // A live rotation already supplied the newer session. Do not restore the
      // older response or archive an incomplete status preview.
      if (state.bots[slug]?.sessionId !== before.sessionId) {
        return;
      }
      const rotated = body.sessionId !== before.sessionId;
      if (rotated) {
        streams.get(slug)?.close();
        streams.delete(slug);
        onSession(slug, body.sessionId);
        snapshotAfterRotation.delete(slug);
        // If this response belongs to an already pending rotation, it is the
        // replacement session's bounded snapshot; allow its guarded connect
        // below instead of leaving the pending gate latched.
        snapshotReconnectPending.delete(slug);
      }
      patchBot(slug, (b) => {
        const resumeLine =
          typeof body.resumeAfter === "number"
            ? Math.max(-1, body.resumeAfter - 1)
            : b.lastLine;
        const rows = [
          ...new Map(
            [...body.rows, ...b.rows].map((row) => [keyOf(row), row])
          ).values(),
        ].sort(
          (left, right) => left.line - right.line || left.index - right.index
        );
        return {
          ...b,
          consults: new Map([
            ...b.consults,
            ...body.consults.map(
              (c) => [c.callId, { id: c.id, peerName: c.peerName }] as const
            ),
          ]),
          historyCursor: body.historyCursor ?? b.historyCursor,
          historyHasMore: body.historyHasMore ?? b.historyHasMore,
          lastLine: Math.max(b.lastLine, resumeLine),
          // A consumption that only reached this snapshot (a reconnect, a rotation) settles
          // exactly the pending message it names; admission alone, or no evidence, keeps it.
          pending: settledBy(b.pending, body.rows),
          rows,
          snapshotStatus: "ready",
        };
      });
      if (
        rotated &&
        state.bots[slug]?.sessionId === body.sessionId &&
        wanted(slug) &&
        !streams.has(slug)
      ) {
        connect(slug);
      }
    } catch {
      patchBot(slug, (b) =>
        b.sessionId === before.sessionId ? { ...b, snapshotStatus: "error" } : b
      );
    }
  }

  async function loadEarlier(slug: string) {
    const before = state.bots[slug];
    if (
      !before ||
      before.historyStatus === "loading" ||
      before.pastStatus === "loading"
    ) {
      return;
    }
    if (before.sessionId && before.historyHasMore && before.historyCursor) {
      // The active session is the contiguous frontier immediately before the
      // current live window. Drain it before touching archived sessions.
      await loadActiveEarlier(slug, before);
      return;
    }
    if (before.pastHasMore) {
      await loadPast(slug);
    }
  }

  async function loadActiveEarlier(slug: string, before: BotState) {
    if (!(before.sessionId && before.historyCursor)) {
      return;
    }
    patchBot(slug, (b) => ({ ...b, historyStatus: "loading" }));
    try {
      const response = await deps.fetch(
        `/api/bots/${encodeURIComponent(slug)}/snapshot?session=${encodeURIComponent(before.sessionId)}&before=${encodeURIComponent(JSON.stringify(before.historyCursor))}`,
        { cache: "no-store" }
      );
      if (response.status === 409) {
        patchBot(slug, (b) =>
          b.sessionId === before.sessionId ? { ...b, historyStatus: "idle" } : b
        );
        return;
      }
      if (!response.ok) {
        throw new Error("Earlier messages unavailable");
      }
      const body = (await response.json()) as {
        historyCursor?: HistoryCursor | null;
        historyHasMore?: boolean;
        rows: ClientRow[];
        sessionId: string | null;
      };
      patchBot(slug, (b) => {
        if (b.sessionId !== body.sessionId) {
          return { ...b, historyStatus: "idle" };
        }
        const rows = [
          ...new Map(
            [...body.rows, ...b.rows].map((row) => [keyOf(row), row])
          ).values(),
        ].sort(
          (left, right) => left.line - right.line || left.index - right.index
        );
        return {
          ...b,
          historyCursor: body.historyCursor ?? null,
          historyHasMore: body.historyHasMore ?? false,
          historyStatus: body.historyHasMore ? "idle" : "ready",
          rows,
        };
      });
    } catch {
      patchBot(slug, (b) =>
        b.sessionId === before.sessionId ? { ...b, historyStatus: "error" } : b
      );
    }
  }

  async function loadArchivedFacts(
    slug: string,
    before: BotState,
    oldest: PastSession
  ) {
    patchBot(slug, (b) => ({ ...b, pastStatus: "loading" }));
    try {
      const archiveQuery = new URLSearchParams({
        archive: oldest.sessionId,
        before: JSON.stringify(oldest.historyCursor),
      });
      if (before.sessionId) {
        archiveQuery.set("session", before.sessionId);
      }
      const response = await deps.fetch(
        `/api/bots/${encodeURIComponent(slug)}/snapshot?${archiveQuery.toString()}`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error("Could not load earlier archive facts");
      }
      const body = (await response.json()) as {
        historyCursor?: HistoryCursor | null;
        historyHasMore?: boolean;
        historySessionId?: string | null;
        rows: ClientRow[];
        sessionId: string | null;
      };
      patchBot(slug, (b) => {
        if (
          b.sessionId !== body.sessionId ||
          (body.historySessionId && body.historySessionId !== oldest.sessionId)
        ) {
          return { ...b, pastStatus: "idle" };
        }
        const index = b.past.findIndex(
          (session) => session.sessionId === oldest.sessionId
        );
        if (index < 0) {
          return { ...b, pastStatus: "idle" };
        }
        const current = b.past[index];
        const rows = [
          ...new Map(
            [...body.rows, ...current.rows].map((row) => [keyOf(row), row])
          ).values(),
        ].sort(
          (left, right) => left.line - right.line || left.index - right.index
        );
        const past = [...b.past];
        past[index] = {
          ...current,
          historyCursor: body.historyCursor ?? null,
          historyHasMore: body.historyHasMore ?? false,
          rows,
        };
        return {
          ...b,
          past,
          pastHasMore:
            b.pastHasMore || past.some((session) => session.historyHasMore),
          pastStatus: "ready",
          // A message admitted in the replaced session is settled by its consumption there.
          pending: settledBy(b.pending, body.rows),
        };
      });
    } catch {
      patchBot(slug, (b) =>
        b.sessionId === before.sessionId ? { ...b, pastStatus: "error" } : b
      );
    }
  }

  async function loadArchivedSessions(slug: string, before: BotState) {
    patchBot(slug, (b) => ({ ...b, pastStatus: "loading" }));
    try {
      const response = await deps.fetch(
        `/api/bots/${encodeURIComponent(slug)}/past-sessions${
          before.pastCursor
            ? `?before=${encodeURIComponent(JSON.stringify(before.pastCursor))}`
            : ""
        }`,
        { cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error("Could not load earlier conversations");
      }
      const body = (await response.json()) as {
        nextCursor?: PastCursor | null;
        past: PastSession[];
        sessionId: string | null;
      };
      patchBot(slug, (b) => {
        // A session rotation while the snapshot was loading must not overwrite newer history.
        if (b.sessionId !== body.sessionId) {
          return { ...b, pastStatus: "idle" };
        }
        const local = new Map(b.past.map((p) => [p.sessionId, p]));
        const past = [
          ...body.past.filter((p) => !local.has(p.sessionId)),
          ...b.past,
        ];
        return {
          ...b,
          past,
          pastCursor: body.nextCursor ?? null,
          pastHasMore:
            Boolean(body.nextCursor) ||
            past.some((session) => session.historyHasMore),
          pastStatus: "ready",
          pending: settledBy(
            b.pending,
            body.past.flatMap((session) => session.rows)
          ),
        };
      });
    } catch {
      patchBot(slug, (b) =>
        b.sessionId === before.sessionId ? { ...b, pastStatus: "error" } : b
      );
    }
  }

  async function loadPast(slug: string) {
    const before = state.bots[slug];
    if (!before) {
      return;
    }
    if (before.pastStatus === "loading") {
      return;
    }
    const [oldest] = before.past;
    const hasArchivedFacts = before.past.some((session) =>
      Boolean(session.historyHasMore && session.historyCursor)
    );
    if (
      before.pastStatus === "ready" &&
      !before.pastHasMore &&
      !hasArchivedFacts
    ) {
      return;
    }
    if (oldest?.historyHasMore && oldest.historyCursor) {
      await loadArchivedFacts(slug, before, oldest);
      return;
    }
    if (before.pastHasMore) {
      await loadArchivedSessions(slug, before);
    }
  }

  async function deliveryResult(
    response: Response | null
  ): Promise<{ deliveryId?: string; issue: AiIssue }> {
    if (response?.ok) {
      const body = await response.json().catch(() => null);
      const deliveryId =
        body &&
        typeof body === "object" &&
        typeof (body as { deliveryId?: unknown }).deliveryId === "string"
          ? (body as { deliveryId: string }).deliveryId
          : undefined;
      return { deliveryId, issue: aiIssue("message_delivery_failed") };
    }

    const body = await response?.json().catch(() => null);
    const code =
      body && typeof body === "object"
        ? ((body as { code?: unknown; error?: unknown }).code ??
          (body as { error?: unknown }).error)
        : undefined;
    const known = typeof code === "string" && PUBLIC_ISSUE_CODES.has(code);
    // This is a Busy route, so an empty/proxy 401 means the Busy session expired. A
    // non-structured 403 (or any other unknown response) remains a generic delivery error.
    if (response?.status === 401) {
      return { issue: issueFromProviderStatus(401, null, "busy") };
    }
    if (known) {
      return {
        issue:
          aiIssueFromResponse(body, { status: response?.status }) ??
          aiIssue("message_delivery_failed"),
      };
    }
    return { issue: aiIssue("message_delivery_failed") };
  }

  /**
   * A fast turn (docs/fast-path.md) answers the POST itself, with facts shaped like the SSE
   * stream's. A `retract` drops the draft it showed and puts the user's message back as pending. A fact
   * re-sent under a key it already showed replaces it: a kept ack swaps `fast:<id>` for eve's id.
   */
  async function readFast(
    slug: string,
    pending: Pending,
    res: Response
  ): Promise<{ deliveryId?: string; ended: boolean }> {
    let deliveryId: string | undefined;
    // The final `{deliveryId}` or `{error}` line: without it the stream was cut, not answered.
    let ended = false;
    const shown = new Set<string>();
    const applyFact = (fact: ClientRow) => {
      const key = keyOf(fact);
      if (shown.has(key)) {
        patchBot(slug, (b) => ({
          ...b,
          rows: b.rows.map((r) => (keyOf(r) === key ? fact : r)),
        }));
        return;
      }
      shown.add(key);
      onFact(slug, fact);
      if (fact.type === "delivery.consumed") {
        patchBot(slug, (b) => ({
          ...b,
          pending: b.pending.filter((p) => p.id !== pending.id),
        }));
      }
    };
    const apply = (line: string) => {
      const msg = JSON.parse(line) as {
        deliveryId?: unknown;
        error?: unknown;
        fact?: ClientRow;
        progress?: Parameters<typeof onProgress>[1];
        retract?: true;
        status?: unknown;
      };
      onStatus(slug, msg.status);
      if (msg.fact) {
        applyFact(msg.fact);
      } else if (msg.progress) {
        onProgress(slug, msg.progress);
      } else if (msg.retract) {
        patchBot(slug, (b) => ({
          ...b,
          deltas: new Map(),
          pending: b.pending.some((p) => p.id === pending.id)
            ? b.pending
            : [...b.pending, pending],
          rows: b.rows.filter((r) => !shown.has(keyOf(r))),
        }));
        shown.clear();
      } else if (typeof msg.deliveryId === "string") {
        ({ deliveryId } = msg);
        ended = true;
      } else if (typeof msg.error === "string") {
        ended = true;
      }
    };
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    try {
      while (reader) {
        // biome-ignore lint/performance/noAwaitInLoops: a stream is read in order
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffered += value;
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) {
            apply(line);
          }
        }
      }
    } catch {
      // A cut stream: the server still stores the reply; a reload shows it.
    }
    return { deliveryId, ended };
  }

  /** `cut`: a fast stream that ended before its final line, which is not an answer. */
  async function answerOf(
    slug: string,
    pending: Pending,
    response: Response | null
  ): Promise<{ cut: boolean; deliveryId?: string; issue: AiIssue }> {
    if (
      !response?.headers
        ?.get("content-type")
        ?.startsWith("application/x-ndjson")
    ) {
      return { cut: false, ...(await deliveryResult(response)) };
    }
    const fast = await readFast(slug, pending, response);
    return {
      cut: !fast.ended,
      deliveryId: fast.deliveryId,
      issue: aiIssue("message_delivery_failed"),
    };
  }

  // Keep the delivery boundary separate from the model error stream. A message POST only queues
  // work; provider failures are recorded later by eve and classified from persisted events.
  async function deliver(slug: string, pending: Pending): Promise<boolean> {
    const post = (reconcile = false) =>
      deps.fetch(
        `/api/bots/${encodeURIComponent(slug)}/messages${reconcile ? "?reconcile=1" : ""}`,
        {
          body: JSON.stringify({
            fileIds: pending.fileIds ?? [],
            id: pending.id,
            text: pending.text,
            ...(pending.timeZone
              ? { clientContext: { timeZone: pending.timeZone } }
              : {}),
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }
      );

    // Same id on retry: the hub and eve deduplicate (spec 4.3). Retry only transport/server
    // failures automatically. A 4xx (including 401/403/409/429) is actionable and must wait for
    // the user; immediately repeating it only creates noise and can repeat provider pressure.
    let res = await post().catch(() => null);
    if (!res || res.status >= 500) {
      res = await post().catch(() => null);
    }

    const first = await answerOf(slug, pending, res);
    let { deliveryId, issue } = first;
    if (first.cut && !deliveryId) {
      // The fast stream was cut before its final line. The hub keeps delivering and may have stored
      // it: show it as still sending, then ask once with the same id (no fast path) for the truth.
      patchBot(slug, (b) => ({
        ...b,
        pending: b.pending.map((p) =>
          p.id === pending.id ? { ...p, uncertain: true } : p
        ),
      }));
      ({ deliveryId, issue } = await answerOf(
        slug,
        pending,
        await post(true).catch(() => null)
      ));
    }

    patchBot(slug, (b) => {
      // The stream can deliver delivery.consumed before the POST answers: then it is already in rows.
      const consumed =
        Boolean(deliveryId) &&
        b.rows.some(
          (r) =>
            r.type === "delivery.consumed" &&
            r.data.data.deliveryId === deliveryId
        );
      return {
        ...b,
        pending: consumed
          ? b.pending.filter((p) => p.id !== pending.id)
          : b.pending.map((p) =>
              p.id === pending.id
                ? {
                    ...p,
                    deliveryId,
                    failed: !deliveryId,
                    issue: deliveryId ? undefined : issue,
                    uncertain: undefined,
                  }
                : p
            ),
      };
    });
    return Boolean(deliveryId);
  }

  return {
    /** Answers the question the bot's turn paused on; the card closes when the bot's call settles. */
    async answer(
      slug: string,
      interactionId: string,
      answer: { optionId?: string; text?: string } | string
    ): Promise<boolean> {
      const value = typeof answer === "string" ? { optionId: answer } : answer;
      const res = await deps
        .fetch(`/api/bots/${encodeURIComponent(slug)}/answer`, {
          body: JSON.stringify({ interactionId, ...value }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
        .catch(() => null);
      return Boolean(res?.ok);
    },
    getServerState: () => serverState,
    getState: () => state,
    loadEarlier,
    loadPast,
    loadSnapshot,
    pauseStreams() {
      streamsActive = false;
      for (const stream of streams.values()) {
        stream.close();
      }
      streams.clear();
    },
    /** Warm conversation data without reserving an idle live-stream connection. */
    preload(slug: string) {
      return loadSnapshot(slug);
    },
    /** A deleted bot: its stream closes and, if it was on screen, the next bot takes its place. */
    removeBot(slug: string) {
      streams.get(slug)?.close();
      streams.delete(slug);
      followedStreams.delete(slug);
      snapshotReconnectPending.delete(slug);
      snapshotAfterRotation.delete(slug);
      progressLines.delete(slug);
      const bots = { ...state.bots };
      delete bots[slug];
      set({
        bots,
        order: state.order.filter((s) => s !== slug),
        selected: state.selected === slug ? null : state.selected,
      });
    },
    resumeStreams() {
      if (streamsActive) {
        return;
      }
      streamsActive = true;
      for (const slug of followedStreams) {
        if (wanted(slug)) {
          connect(slug);
        } else {
          followedStreams.delete(slug);
        }
      }
    },
    /** Retry a failed delivery with its original id, text, files and browser context. */
    retry(slug: string, id: string): Promise<boolean> {
      const pending = state.bots[slug]?.pending.find(
        (item) => item.id === id && item.failed
      );
      if (!pending) {
        return Promise.resolve(false);
      }
      // Claim the failed item before starting network work. This makes two rapid clicks one
      // idempotent retry instead of two concurrent POSTs with the same message id.
      patchBot(slug, (b) => ({
        ...b,
        pending: b.pending.map((item) =>
          item.id === id
            ? { ...item, error: undefined, failed: false, issue: undefined }
            : item
        ),
      }));
      return deliver(slug, pending);
    },
    select(slug: string) {
      if (state.selected !== slug) {
        set({ ...state, selected: slug });
      }
      loadSnapshot(slug).catch(() => undefined);
      connect(slug);
      for (const other of [...streams.keys()]) {
        release(other);
      }
    },
    async send(
      slug: string,
      msg: {
        id: string;
        text: string;
        files: { id: string; name: string }[];
      }
    ) {
      if (state.bots[slug]?.pending.some((item) => item.id === msg.id)) {
        return;
      }
      // The browser is the source of truth for the user's wall-clock zone. Capture it once so a
      // retry of the same delivery keeps identical semantics if the OS zone changes mid-request.
      const timeZone =
        typeof Intl === "undefined"
          ? undefined
          : Intl.DateTimeFormat().resolvedOptions().timeZone;
      const pending: Pending = {
        fileIds: msg.files.map((f) => f.id),
        files: msg.files.map((f) => f.name),
        id: msg.id,
        text: msg.text,
        ...(typeof timeZone === "string" && timeZone.length > 0
          ? { timeZone }
          : {}),
      };
      deps.rum?.send(slug);
      patchBot(slug, (b) => ({ ...b, pending: [...b.pending, pending] }));
      // Deliver outside the optional call: `rum?.ack(…, await deliver())` would skip delivery.
      const delivered = await deliver(slug, pending);
      deps.rum?.ack(slug, delivered);
    },
    /** Asks the bot to stop that turn. eve cancels asynchronously: the turn ends when its settle arrives. */
    async stop(slug: string, turnId: string): Promise<boolean> {
      const res = await deps
        .fetch(`/api/bots/${encodeURIComponent(slug)}/stop`, {
          body: JSON.stringify({ turnId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        })
        .catch(() => null);
      return Boolean(res?.ok);
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    upsertBot(bot: BotLite) {
      const existing = state.bots[bot.slug];
      set({
        ...state,
        bots: {
          ...state.bots,
          [bot.slug]: existing
            ? { ...existing, bot }
            : toBotState({
                ...bot,
                consults: [],
                past: [],
                rows: [],
                sessionId: null,
              }),
        },
        order: existing ? state.order : [...state.order, bot.slug],
      });
      if (bot.status === "ready") {
        connect(bot.slug);
      }
    },
    /**
     * Wakes the bot while the user writes, at most once per WARM_EVERY_MS per bot. The hub ignores
     * it unless BOT_PREWARM=1 (docs/chat-prewarm.md); it never starts a turn.
     */
    warm(slug: string, now = Date.now()) {
      if (
        now - (warmedAt.get(slug) ?? Number.NEGATIVE_INFINITY) <
        WARM_EVERY_MS
      ) {
        return;
      }
      warmedAt.set(slug, now);
      deps
        .fetch(`/api/bots/${encodeURIComponent(slug)}/warm`, { method: "POST" })
        .catch(() => {
          // Best effort: the send keeps its own retries.
        });
    },
  };
}

export type ChatStore = ReturnType<typeof createChatStore>;
