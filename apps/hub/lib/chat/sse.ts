import type { Billing } from "../bots/models";
import type { StreamRecord } from "../eve/client";
import { stageFields } from "../trace";
import { sanitizeAiFact } from "./model-errors";
import { errorCodeOf, logChatObservation } from "./observability";
import type { EventRow, Fact } from "./sync";

export type Send = (event: string, data: unknown, id?: number) => void;

export interface RelayObservation {
  botSlug?: string;
  callId?: string;
  childSessionId?: string;
  parentSessionId?: string;
  requestId?: string;
  sessionId?: string;
  /** Setup stages before the live stream (lib/trace.ts), logged with the stream's line. */
  stages?: Record<string, number>;
}

interface RelaySaveState {
  maxQueuedBytes: number;
  maxQueuedRows: number;
  oversizedRecordBytes: number;
  oversizedRecordCount: number;
  pending?: PendingSave;
  pendingTimer?: ReturnType<typeof setTimeout>;
  pressureWaits: number;
  queuedBytes: number;
  queuedRows: number;
  rowsScheduled: number;
  saveCalls: number;
  saveDurationMs: number;
  saveErrorCode?: string;
  saveFailed: boolean;
  saving: Promise<void>;
}

interface PendingSave {
  bytes: number;
  nextLine: number;
  rows: EventRow[];
}

const MAX_SAVE_ROWS = 256;
const MAX_SAVE_WAIT_MS = 25;
export const MAX_QUEUED_ROWS = 4096;
export const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

function estimateRowsBytes(rows: EventRow[]): number {
  return rows.reduce(
    (bytes, row) => bytes + JSON.stringify(row.data).length * 2 + 64,
    0
  );
}

function runSave(
  state: RelaySaveState,
  save: (rows: EventRow[], nextLine: number) => Promise<void>,
  pending: PendingSave
): void {
  state.saveCalls += 1;
  state.rowsScheduled += pending.rows.length;
  state.saving = state.saving
    .then(async () => {
      if (state.saveFailed) {
        return;
      }
      const saveStartedAt = Date.now();
      try {
        await save(pending.rows, pending.nextLine);
      } catch (error) {
        state.saveFailed = true;
        state.saveErrorCode = errorCodeOf(error);
      } finally {
        state.saveDurationMs += Date.now() - saveStartedAt;
        state.queuedRows = Math.max(0, state.queuedRows - pending.rows.length);
        state.queuedBytes = Math.max(0, state.queuedBytes - pending.bytes);
      }
    })
    .catch((error) => {
      state.saveFailed = true;
      state.saveErrorCode ??= errorCodeOf(error);
    });
}

function flushRelaySave(
  state: RelaySaveState,
  save: (rows: EventRow[], nextLine: number) => Promise<void>
): void {
  if (state.pendingTimer) {
    clearTimeout(state.pendingTimer);
    state.pendingTimer = undefined;
  }
  const { pending } = state;
  if (!pending) {
    return;
  }
  state.pending = undefined;
  runSave(state, save, pending);
}

async function queueRelaySave(
  state: RelaySaveState,
  save: (rows: EventRow[], nextLine: number) => Promise<void>,
  rows: EventRow[],
  nextLine: number
): Promise<void> {
  const bytes = estimateRowsBytes(rows);
  const oversized = bytes > MAX_QUEUED_BYTES;
  if (oversized) {
    // Keep one oversized atomic SDK record isolated from older pending rows.
    // It may exceed the queue byte budget, but it is never split or dropped.
    flushRelaySave(state, save);
    await state.saving;
    state.oversizedRecordCount += 1;
    state.oversizedRecordBytes = Math.max(state.oversizedRecordBytes, bytes);
  }
  const pending = state.pending ?? { bytes: 0, nextLine, rows: [] };
  pending.rows.push(...rows);
  pending.bytes += bytes;
  pending.nextLine = Math.max(pending.nextLine, nextLine);
  state.pending = pending;
  state.queuedRows += rows.length;
  state.queuedBytes += bytes;
  state.maxQueuedRows = Math.max(state.maxQueuedRows, state.queuedRows);
  state.maxQueuedBytes = Math.max(state.maxQueuedBytes, state.queuedBytes);
  if (oversized || pending.rows.length >= MAX_SAVE_ROWS) {
    flushRelaySave(state, save);
    if (oversized) {
      await state.saving;
      return;
    }
  } else if (!state.pendingTimer) {
    state.pendingTimer = setTimeout(() => {
      state.pendingTimer = undefined;
      flushRelaySave(state, save);
    }, MAX_SAVE_WAIT_MS);
  }
  if (
    !oversized &&
    (state.queuedRows > MAX_QUEUED_ROWS || state.queuedBytes > MAX_QUEUED_BYTES)
  ) {
    state.pressureWaits += 1;
    flushRelaySave(state, save);
    return state.saving;
  }
  return Promise.resolve();
}

function relayOutcome(
  streamErrorCode: string | undefined,
  saveFailed: boolean,
  closed: boolean
): string {
  if (streamErrorCode) {
    return "failed";
  }
  if (saveFailed) {
    return "persistence_failed";
  }
  return closed ? "closed" : "completed";
}

/** An SSE response that pings every 15 s and never writes after the client left. */
export function sseResponse(
  req: Request,
  run: (send: Send, closed: () => boolean, signal: AbortSignal) => Promise<void>
): Response {
  const encoder = new TextEncoder();
  let closed = false;
  let streamCanceled = false;
  const abortController = new AbortController();
  const abort = () => {
    closed = true;
    abortController.abort();
  };
  if (req.signal.aborted) {
    abort();
  } else {
    req.signal.addEventListener("abort", abort, { once: true });
  }
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      streamCanceled = true;
      abort();
    },
    async start(controller) {
      const write = (s: string) => {
        if (closed) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(s));
        } catch {
          abort();
        }
      };
      const send: Send = (event, data, id) =>
        write(
          `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        );
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      try {
        await run(send, () => closed, abortController.signal);
      } catch {
        // The client reconnects from its last line; the cron fills any gap.
      } finally {
        clearInterval(ping);
        if (!streamCanceled) {
          try {
            controller.close();
          } catch {
            // The consumer may have canceled between the state check and close.
          }
        }
        abort();
        req.signal.removeEventListener("abort", abort);
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}

interface TurnStart {
  /** Epoch ms when the hub forwarded it. */
  at: number;
  /** How far behind eve's own timestamp. */
  lagMs: number | undefined;
}

/** Set when these facts start a turn. */
function turnStartSeen(facts: Fact[], at: Date): TurnStart | undefined {
  if (!facts.some((fact) => fact.type === "turn.started")) {
    return;
  }
  const now = Date.now();
  const lag = now - at.getTime();
  return {
    at: now,
    lagMs: Number.isFinite(lag) ? Math.max(0, lag) : undefined,
  };
}

/**
 * Forwards each record at once and persists durable facts in bounded batches behind the client.
 * Deltas are forwarded, never stored. After a failed save, later ones are skipped: the cursor must
 * never pass a line that wasn't stored, or the cron (which reads from it) would never bring that
 * line back. Resolves true when every line read was saved.
 */
export async function relay(
  records: AsyncIterable<StreamRecord>,
  save: (rows: EventRow[], nextLine: number) => Promise<void>,
  send: Send,
  closed: () => boolean,
  provider?: Billing,
  observation?: RelayObservation
): Promise<boolean> {
  const saveState: RelaySaveState = {
    maxQueuedBytes: 0,
    maxQueuedRows: 0,
    oversizedRecordBytes: 0,
    oversizedRecordCount: 0,
    pressureWaits: 0,
    queuedBytes: 0,
    queuedRows: 0,
    rowsScheduled: 0,
    saveCalls: 0,
    saveDurationMs: 0,
    saveFailed: false,
    saving: Promise.resolve(),
  };
  let recordsSeen = 0;
  let factsForwarded = 0;
  let firstLine: number | undefined;
  let lastLine: number | undefined;
  let streamErrorCode: string | undefined;
  // When the stream's first record reached the hub, and the first turn.started passed through it
  // (epoch ms, and how far behind eve's own timestamp): the delivery → turn gap a user waits on.
  let firstRecordMs: number | undefined;
  let turnStart: TurnStart | undefined;
  const startedAt = Date.now();
  try {
    for await (const { line, record } of records) {
      if (saveState.saveFailed) {
        break;
      }
      recordsSeen += 1;
      firstRecordMs ??= Date.now() - startedAt;
      firstLine ??= line;
      lastLine = line;
      if (closed()) {
        break;
      }
      if (record.progress) {
        send("progress", { line, ...(record.progress as object) });
        continue;
      }
      const facts = ((record.facts as Fact[] | undefined) ?? []).map((fact) =>
        sanitizeAiFact(fact, provider)
      );
      factsForwarded += facts.length;
      const at = record.at ? new Date(String(record.at)) : new Date();
      turnStart ??= turnStartSeen(facts, at);
      facts.forEach((fact, index) => {
        send("fact", { data: fact, index, line, type: fact.type }, line);
      });
      const rows = facts.map((fact, index) => ({
        at,
        data: fact,
        index,
        line,
        type: fact.type,
      }));
      // Saves intentionally remain serialized so the cursor never advances past a failed line.
      await queueRelaySave(saveState, save, rows, line + 1);
    }
    flushRelaySave(saveState, save);
    await saveState.saving;
  } catch (error) {
    streamErrorCode = errorCodeOf(error);
    throw error;
  } finally {
    flushRelaySave(saveState, save);
    await saveState.saving;
    if (observation && !streamErrorCode) {
      logChatObservation("chat.stream", {
        botSlug: observation.botSlug,
        callId: observation.callId,
        childSessionId: observation.childSessionId,
        durationMs: Date.now() - startedAt,
        errorCode: streamErrorCode ?? saveState.saveErrorCode,
        factsForwarded,
        firstLine: firstLine ?? null,
        firstRecordMs,
        lastLine: lastLine ?? null,
        maxQueuedBytes: saveState.maxQueuedBytes,
        maxQueuedRows: saveState.maxQueuedRows,
        outcome: relayOutcome(streamErrorCode, saveState.saveFailed, closed()),
        oversizedRecordBytes: saveState.oversizedRecordBytes,
        oversizedRecordCount: saveState.oversizedRecordCount,
        parentSessionId: observation.parentSessionId,
        pressureWaits: saveState.pressureWaits,
        recordsSeen,
        requestId: observation.requestId,
        rowCount: saveState.rowsScheduled,
        saveCalls: saveState.saveCalls,
        saveDurationMs: saveState.saveDurationMs,
        sessionId: observation.sessionId,
        turnStartedAt: turnStart?.at,
        turnStartedLagMs: turnStart?.lagMs,
        ...stageFields(observation.stages ?? {}),
      });
    }
  }
  return !(saveState.saveFailed || closed());
}
