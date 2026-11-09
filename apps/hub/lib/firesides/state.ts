import { type ChatItem, toChatView } from "../chat/items";
import { runtimeMetadata } from "./metadata";
import {
  type FiresideCommand,
  type FiresideState,
  otherSpeaker,
} from "./types";

export class FiresideConflict extends Error {}

/**
 * Asks for a participant session to be ended (N-05). Idempotent: a repeated request keeps the
 * original entry, so a session gets one canceller and its first request time.
 */
export function requestCancel(
  state: FiresideState,
  sessionId: string,
  now = new Date()
) {
  if (!state.cancelSessions.includes(sessionId)) {
    state.cancelSessions.push(sessionId);
  }
  state.cancellations ??= {};
  if (state.cancellations[sessionId]) {
    return;
  }
  const participant = Object.values(state.participants).find(
    (p) => p.sessionId === sessionId
  );
  if (!participant) {
    return;
  }
  state.cancellations[sessionId] = {
    attempts: 0,
    computerStopPending: false,
    generation: participant.generation,
    lastError: null,
    nextAttemptAt: null,
    participantId: participant.id,
    requestedAt: now.toISOString(),
  };
}

function cancelActive(state: FiresideState) {
  archiveInterrupted(state);
  const session =
    state.active && state.participants[state.active.participant].sessionId;
  if (session) {
    requestCancel(state, session);
  }
  state.active = null;
}

function closeDiscussion(state: FiresideState) {
  state.summary = summarize(state);
  state.summaryVersion += 1;
  cancelActive(state);
  for (const participant of Object.values(state.participants)) {
    if (participant.sessionId) {
      requestCancel(state, participant.sessionId);
    }
  }
  state.status = "closing";
  state.remaining = { guest: 0, primary: 0 };
}

export function archiveInterrupted(state: FiresideState) {
  const { active } = state;
  if (!active) {
    return;
  }
  const participant = state.participants[active.participant];
  const view = toChatView(
    active.rows,
    new Map(Object.entries(active.deltas)),
    new Map(),
    () => undefined,
    participant.billing
  );
  const items = view.items
    .filter((item) => item.kind !== "user")
    .map((item): ChatItem => {
      if (item.kind === "bot") {
        return { ...item, streaming: false };
      }
      if (item.kind === "interaction") {
        return { ...item, state: "withdrawn" };
      }
      if (item.kind === "login") {
        return { ...item, state: "closed" };
      }
      if (item.kind === "activity" && item.state === "running") {
        return { ...item, state: "stopped" };
      }
      return item;
    });
  if (!items.length) {
    return;
  }
  items.push({ id: `${active.messageId}:stopped`, kind: "stopped" });
  state.messages.push({
    at: new Date().toISOString(),
    id: active.messageId,
    interrupted: true,
    items,
    runtime: participant.sessionId
      ? runtimeMetadata(active, participant)
      : undefined,
    speaker: active.participant,
    text: items
      .flatMap((item) => (item.kind === "bot" ? [item.text] : []))
      .join("\n\n"),
  });
}

/** Only user commands grant a budget. Runtime events can consume, never replenish it. */
export function applyCommand(
  state: FiresideState,
  command: FiresideCommand,
  now = new Date()
) {
  if (command.revision !== state.revision && command.kind !== "close") {
    throw new FiresideConflict("The conversation changed. Please try again.");
  }
  if (command.kind === "close") {
    if (state.status === "closed" || state.status === "closing") {
      return;
    }
    closeDiscussion(state);
  } else if (command.kind === "pause") {
    if (state.status !== "running") {
      return;
    }
    cancelActive(state);
    state.status = "paused";
  } else {
    if (state.status === "closing") {
      throw new FiresideConflict("The conversation is still closing.");
    }
    if (command.kind === "continue" && state.status === "running") {
      return;
    }
    if (command.kind === "intervene") {
      cancelActive(state);
      state.messages.push({
        at: now.toISOString(),
        id: command.id,
        speaker: "user",
        text: command.text,
      });
    }
    if (command.kind === "intervene" || state.status !== "paused") {
      state.remaining = { guest: 1, primary: 1 };
    }
    state.status = "running";
    state.summary = null;
    state.error = null;
  }
  state.revision += 1;
}

export function nextSpeaker(state: FiresideState) {
  if (
    state.status !== "running" ||
    state.active ||
    state.cancelSessions.length
  ) {
    return null;
  }
  const next = otherSpeaker(state.lastSpeaker);
  return state.remaining[next] > 0 ? next : null;
}

function positionExcerpt(text: string) {
  return text.length > 2000
    ? `${text.slice(0, 1000)}\n[…]\n${text.slice(-1000)}`
    : text;
}

/** Extractive handoff: every conclusion remains attributed; interrupted turns never invent consensus. */
export function summarize(state: FiresideState): string {
  const latest = new Map<string, string>();
  for (const message of state.messages) {
    if (!message.interrupted) {
      latest.set(message.speaker, message.text);
    }
  }
  const lines = Object.entries(state.participants).flatMap(([role, p]) => {
    const text = latest.get(role);
    return text
      ? [`${p.name} (${p.model}): ${positionExcerpt(text)}`]
      : [`${p.name}: did not complete a response.`];
  });
  const user = state.messages.filter((m) => m.speaker === "user");
  if (user.length) {
    lines.push(
      `User interventions:\n${user
        .map((m) => m.text)
        .join("\n")
        .slice(-3000)}`
    );
  }
  if (state.remaining.primary || state.remaining.guest || state.error) {
    lines.push(
      "The exchange was interrupted; some points may remain unanswered."
    );
  }
  return lines.join("\n\n");
}
