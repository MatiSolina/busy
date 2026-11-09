import { type ClientRow, toChatView } from "../chat/items";
import { sanitizeAiFact } from "../chat/model-errors";
import type { Fact } from "../chat/sync";
import type { StreamRecord } from "../eve/client";
import {
  firesideRuntimeEvent,
  MAX_FIRESIDE_RUNTIME_EVENTS,
  runtimeMetadata,
} from "./metadata";
import { archiveInterrupted, requestCancel } from "./state";
import type { ActiveTurn, FiresideState, Participant } from "./types";

function appendProgress(active: ActiveTurn, record: StreamRecord["record"]) {
  const progress = record.progress as
    | {
        type?: string;
        data?: { partId?: string; delta?: string; kind?: string };
      }
    | undefined;
  if (
    progress?.type !== "content.delta" ||
    !progress.data?.partId ||
    typeof progress.data.delta !== "string"
  ) {
    return;
  }
  const key = progress.data.partId;
  active.contentKinds ??= {};
  const kinds = active.contentKinds;
  if (progress.data.kind && !kinds[key]) {
    kinds[key] = progress.data.kind;
  }
  // Like the main chat, never send reasoning or untyped progress to the browser.
  if (kinds[key] === "text") {
    active.deltas[key] = (
      (active.deltas[key] ?? "") + progress.data.delta
    ).slice(0, 64_000);
  }
}

function appendEventMetadata(
  active: ActiveTurn,
  line: number,
  record: StreamRecord["record"],
  facts: Fact[]
) {
  active.eventMetadata ??= [];
  for (const fact of facts) {
    const metadata = firesideRuntimeEvent(line, record, fact);
    if (metadata) {
      active.eventMetadata.push(metadata);
    }
  }
  if (active.eventMetadata.length > MAX_FIRESIDE_RUNTIME_EVENTS) {
    active.eventsTruncated = true;
    active.eventMetadata.splice(
      0,
      active.eventMetadata.length - MAX_FIRESIDE_RUNTIME_EVENTS
    );
  }
}

function updateTurnId(active: ActiveTurn, facts: Fact[]) {
  for (const fact of facts) {
    if (fact.type === "turn.started" && typeof fact.data.turnId === "string") {
      active.turnId = fact.data.turnId;
    }
    if (
      fact.type === "delivery.consumed" &&
      fact.data.deliveryId === active.deliveryId &&
      typeof fact.data.turnId === "string"
    ) {
      active.turnId = fact.data.turnId;
    }
  }
}

function appendRecords(
  active: ActiveTurn,
  participant: Participant,
  records: StreamRecord[]
) {
  for (const { line, record } of records) {
    if (line < participant.cursor) {
      continue;
    }
    appendProgress(active, record);
    const facts = (record.facts as Fact[] | undefined) ?? [];
    appendEventMetadata(active, line, record, facts);
    const rows: ClientRow[] = facts.map((fact, index) => ({
      data: sanitizeAiFact(fact, participant.billing),
      index,
      line,
      type: fact.type,
    }));
    active.rows.push(...rows);
    participant.cursor = line + 1;
    updateTurnId(active, facts);
  }
  if (active.rows.length > 5000) {
    throw new Error("Fireside turn exceeded its event limit.");
  }
}

/** Native completion, never a delivery acknowledgement, consumes a participant's slot. */
export function projectRecords(state: FiresideState, records: StreamRecord[]) {
  const { active } = state;
  if (!active || active.revision !== state.revision) {
    return;
  }
  const participant = state.participants[active.participant];
  appendRecords(active, participant, records);
  const settled = active.rows.find(
    (row) =>
      row.type === "turn.settled" && row.data.data.turnId === active.turnId
  );
  if (!settled) {
    return;
  }
  const view = toChatView(
    active.rows,
    new Map(),
    new Map(),
    () => undefined,
    participant.billing
  );
  if (settled.data.data.outcome === "completed") {
    const replyIds = new Set(
      Array.isArray(settled.data.data.reply)
        ? (settled.data.data.reply as string[])
        : []
    );
    const text = active.rows
      .filter(
        (row) =>
          row.type === "content.completed" &&
          replyIds.has(String(row.data.data.partId)) &&
          row.data.data.kind === "text"
      )
      .map((row) => String(row.data.data.value ?? ""))
      .join("\n\n");
    state.messages.push({
      at: new Date().toISOString(),
      id: active.messageId,
      items: view.items.filter((item) => item.kind !== "user"),
      runtime: participant.sessionId
        ? runtimeMetadata(active, participant)
        : undefined,
      speaker: active.participant,
      text,
    });
    state.remaining[active.participant] = Math.max(
      0,
      state.remaining[active.participant] - 1
    );
    state.lastSpeaker = active.participant;
    if (!(state.remaining.primary || state.remaining.guest)) {
      state.status = "waiting";
    }
  } else {
    archiveInterrupted(state);
    state.error =
      "The response was interrupted. You can continue or write a message.";
    state.status = "paused";
    if (participant.sessionId) {
      requestCancel(state, participant.sessionId);
    }
  }
  state.active = null;
  state.revision += 1;
}
