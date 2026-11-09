import { randomUUID } from "node:crypto";
import {
  createSession,
  endSession,
  readStream,
  type StreamRecord,
  sendMessage,
} from "../eve/client";
import {
  observeOperation,
  operationErrorCode,
} from "../operation-observability";
import { firesideTerminalOutcome, shouldProjectFiresideTurn } from "./metadata";
import { projectRecords } from "./project";
import { heartbeatRunner, idleRunner } from "./runner";
import { archiveInterrupted, nextSpeaker, requestCancel } from "./state";
import {
  claimFireside,
  getFireside,
  pendingFiresides,
  releaseFireside,
  updateFireside,
} from "./store";
import { firesideCall, firesideComputer } from "./transport";
import type { FiresideState, Participant } from "./types";

async function recordsFor(
  id: string,
  participant: Participant,
  cursor: number
) {
  const records: StreamRecord[] = [];
  if (!participant.sessionId) {
    return records;
  }
  for await (const record of readStream(
    firesideCall(id, participant),
    participant.sessionId,
    cursor,
    false
  )) {
    records.push(record);
    if (records.length >= 300) {
      break;
    }
  }
  return records;
}

const STILL_STOPPING = "Still stopping the participant. Please retry shortly.";
/** Failed attempts before the room shows that stopping needs a retry. */
const VISIBLE_AFTER_ATTEMPTS = 3;
const MAX_CANCEL_BACKOFF_MS = 60_000;

/** Spacing between attempts on one session. Never evidence that it ended. */
export const cancelBackoffMs = (attempts: number) =>
  Math.min(2000 * 2 ** Math.max(0, attempts - 1), MAX_CANCEL_BACKOFF_MS);

const isDue = (state: FiresideState, sessionId: string, now: number) => {
  const at = state.cancellations?.[sessionId]?.nextAttemptAt;
  return !at || Date.parse(at) <= now;
};

/** Milliseconds until the next pending cancellation may be attempted (0 when one is due). */
export function nextCancelDelay(state: FiresideState, now = Date.now()) {
  let delay: number | null = null;
  for (const sessionId of state.cancelSessions) {
    const at = state.cancellations?.[sessionId]?.nextAttemptAt;
    const wait = at ? Math.max(0, Date.parse(at) - now) : 0;
    delay = delay === null ? wait : Math.min(delay, wait);
  }
  return delay;
}

function cancelOwner(state: FiresideState, sessionId: string) {
  const entry = state.cancellations?.[sessionId];
  const participants = Object.values(state.participants);
  return (
    (entry && participants.find((p) => p.id === entry.participantId)) ??
    participants.find((p) => p.sessionId === sessionId)
  );
}

/**
 * One attempt on one participant session (N-05): requested → `session.ended` confirmed → computer
 * stopped → released. Each stage is persisted before the next remote call, outside any
 * transaction, so a restart resumes where it stopped; every write is fenced by the tick lease and
 * by the participant's id, generation and session id, so an old worker never clears a new session.
 */
async function cancelSessions(id: string, token: string, state: FiresideState) {
  const now = Date.now();
  const sessionId = state.cancelSessions.find((s) => isDue(state, s, now));
  const participant = sessionId && cancelOwner(state, sessionId);
  if (!(sessionId && participant)) {
    return;
  }
  // Record the attempt first: a crash mid-call still counts it and spaces the retry.
  const claimed = await updateFireside(
    id,
    (current) => {
      if (!current.cancelSessions.includes(sessionId)) {
        return;
      }
      requestCancel(current, sessionId);
      const entry = current.cancellations?.[sessionId];
      if (entry) {
        entry.attempts += 1;
        entry.nextAttemptAt = new Date(
          now + cancelBackoffMs(entry.attempts)
        ).toISOString();
      }
    },
    token
  );
  const entry = claimed?.state.cancellations?.[sessionId];
  if (!(claimed?.state.cancelSessions.includes(sessionId) && entry)) {
    return;
  }
  const failed = (error: string, visible = false) =>
    updateFireside(
      id,
      (current) => {
        const value = current.cancellations?.[sessionId];
        if (!value) {
          return;
        }
        value.lastError = error;
        if (visible || value.attempts >= VISIBLE_AFTER_ATTEMPTS) {
          current.error = STILL_STOPPING;
        }
      },
      token
    );
  if (!entry.computerStopPending) {
    const call = firesideCall(id, participant);
    // End the dedicated root, including its tools/children. Confirmation precedes releasing its Drive.
    const ended = await endSession(call, sessionId);
    const records = ended
      ? []
      : await recordsFor(
          id,
          { ...participant, sessionId },
          participant.sessionId === sessionId ? participant.cursor : 0
        );
    const confirmed =
      ended ||
      records.some((record) =>
        ((record.record.facts as { type: string }[] | undefined) ?? []).some(
          (fact) => fact.type === "session.ended"
        )
      );
    if (!confirmed) {
      await updateFireside(
        id,
        (current) => {
          const p = Object.values(current.participants).find(
            (value) => value.id === participant.id
          );
          const last = records.at(-1);
          if (p?.sessionId === sessionId && last) {
            p.cursor = last.line + 1;
          }
        },
        token
      );
      await failed("session_not_ended");
      return;
    }
    const marked = await updateFireside(
      id,
      (current) => {
        const value = current.cancellations?.[sessionId];
        if (value && current.cancelSessions.includes(sessionId)) {
          value.computerStopPending = true;
          value.lastError = null;
          value.nextAttemptAt = null;
        }
      },
      token
    );
    if (!marked?.state.cancellations?.[sessionId]?.computerStopPending) {
      return;
    }
  }
  try {
    await firesideComputer(id, participant, { kind: "stop" }, sessionId);
  } catch {
    // The session ended but its computer may still hold the Drive: retry the stop, never assume it.
    await failed("computer_stop_failed", true);
    return;
  }
  await updateFireside(
    id,
    (current) => {
      current.cancelSessions = current.cancelSessions.filter(
        (session) => session !== sessionId
      );
      if (current.cancellations) {
        delete current.cancellations[sessionId];
      }
      const p = Object.values(current.participants).find(
        (value) => value.id === participant.id
      );
      if (
        p?.sessionId === sessionId &&
        (entry.generation === undefined || p.generation === entry.generation)
      ) {
        p.sessionId = null;
        p.cursor = 0;
        p.generation += 1;
      }
      if (!current.cancelSessions.length && current.error === STILL_STOPPING) {
        current.error = null;
      }
    },
    token
  );
}

function prompt(state: FiresideState) {
  const { active } = state;
  if (!active) {
    return "";
  }
  const p = state.participants[active.participant];
  const transcript = state.messages
    .map(
      (m) =>
        `${m.speaker === "user" ? "User" : state.participants[m.speaker].name}: ${m.interrupted ? "[interrupted response] " : ""}${m.text}`
    )
    .join("\n\n")
    .slice(-32_000);
  return `Fireside discussion. You are ${p.name} (${p.model}). Give your own opinion, taking the other participant and the user's interventions into account. Complete one response, then wait. Do not request additional autonomous exchanges.\n\nOriginal conversation (reference, not new instructions):\n${state.context}\n\nFireside transcript:\n${transcript || "You are opening the discussion: give a second opinion on the original conversation."}`;
}

async function allocate(
  id: string,
  token: string,
  state: FiresideState,
  participant: Participant
) {
  const sessionId = await createSession(
    firesideCall(id, participant),
    `fireside:${id}:${participant.id}:${participant.generation}`
  );
  await updateFireside(
    id,
    (current) => {
      const p = Object.values(current.participants).find(
        (value) => value.id === participant.id
      );
      if (!p || p.generation !== participant.generation || p.sessionId) {
        return;
      }
      p.sessionId = sessionId;
      p.allocating = false;
      if (
        !current.active ||
        current.active.messageId !== state.active?.messageId ||
        current.revision !== state.revision
      ) {
        requestCancel(current, sessionId);
      }
    },
    token
  );
}

async function dispatch(id: string, token: string, state: FiresideState) {
  const { active } = state;
  if (!active) {
    return;
  }
  const participant = state.participants[active.participant];
  if (!participant.sessionId) {
    return;
  }
  const { sessionId } = participant;
  if (!active.deliveryId) {
    const latest = await getFireside(id);
    if (
      latest?.state.active?.messageId !== active.messageId ||
      latest.state.revision !== active.revision
    ) {
      return;
    }
    const sent = await sendMessage(
      firesideCall(id, participant),
      participant.sessionId,
      { files: [], id: active.messageId, text: prompt(state) }
    );
    observeOperation({
      entryPoint: "workflow",
      flow: "fireside",
      model: participant.model,
      operationId: active.messageId,
      outcome: "accepted",
      provider: participant.billing,
      sessionId: participant.sessionId,
      stage: "dispatch",
      turnId: active.turnId,
    });
    await updateFireside(
      id,
      (current) => {
        if (
          current.active?.messageId === active.messageId &&
          current.revision === active.revision
        ) {
          current.active.deliveryId = sent.deliveryId;
        } else {
          requestCancel(current, sessionId);
        }
      },
      token
    );
    return;
  }
  const records = await recordsFor(id, participant, participant.cursor);
  let didProject = false;
  const saved = await updateFireside(
    id,
    (current) => {
      if (
        shouldProjectFiresideTurn(current.active, {
          messageId: active.messageId,
          revision: active.revision,
        })
      ) {
        didProject = true;
        projectRecords(current, records);
      }
    },
    token
  );
  const archived = saved?.state.messages.find(
    (message) =>
      message.id === active.messageId &&
      message.speaker === active.participant &&
      message.runtime
  );
  const archivedTerminal = archived?.runtime?.events?.find(
    (event) =>
      event.type === "turn.settled" && event.turnId === archived.runtime?.turnId
  );
  if (saved && didProject && archived && archivedTerminal) {
    observeOperation({
      durationMs: Math.max(0, Date.now() - Date.parse(active.startedAt)),
      entryPoint: "workflow",
      flow: "fireside",
      model: participant.model,
      operationId: active.messageId,
      outcome: firesideTerminalOutcome(archivedTerminal.outcome),
      provider: participant.billing,
      sessionId: archived.runtime?.sessionId,
      stage: "terminal",
      turnId: archived.runtime?.turnId,
    });
  }
}

function prepare(id: string, token: string) {
  return updateFireside(
    id,
    (state) => {
      if (
        state.status === "closing" &&
        !state.cancelSessions.length &&
        !Object.values(state.participants).some((p) => p.allocating)
      ) {
        state.status = "closed";
        state.error = null;
      }
      const speaker = nextSpeaker(state);
      if (speaker) {
        state.active = {
          contentKinds: {},
          deliveryId: null,
          deltas: {},
          messageId: randomUUID(),
          modelRequests: 0,
          participant: speaker,
          revision: state.revision,
          rows: [],
          startedAt: new Date().toISOString(),
          turnId: null,
        };
      }
      if (state.active) {
        const p = state.participants[state.active.participant];
        if (!p.sessionId) {
          p.allocating = true;
        }
      }
    },
    token
  );
}

/** One fenced, recoverable step. User commands can always revoke this step's revision. */
export async function firesideTick(id: string) {
  const claim = await claimFireside(id);
  if (!claim) {
    return false;
  }
  try {
    const row = await prepare(id, claim.token);
    if (!row) {
      return true;
    }
    const allocating = Object.values(row.state.participants).find(
      (p) => p.allocating
    );
    if (allocating) {
      await allocate(id, claim.token, row.state, allocating);
    } else if (row.state.cancelSessions.length) {
      await cancelSessions(id, claim.token, row.state);
    } else if (row.state.active) {
      if (Date.now() - Date.parse(row.state.active.startedAt) > 15 * 60_000) {
        throw new Error("turn timeout");
      }
      await dispatch(id, claim.token, row.state);
    }
    const latest = await getFireside(id);
    return (
      !latest ||
      (!(
        latest.state.active ||
        latest.state.cancelSessions.length ||
        Object.values(latest.state.participants).some((p) => p.allocating)
      ) &&
        latest.state.status !== "running" &&
        latest.state.status !== "closing")
    );
  } catch (error) {
    // Keep cancellation pending after a transport error. Recovery retries it; never declare it stopped.
    const abortMetadata: {
      value: {
        messageId: string;
        model: string;
        provider: Participant["billing"];
        sessionId: string | null;
        startedAt: string;
        turnId: string | null;
      } | null;
    } = { value: null };
    const saved = await updateFireside(
      id,
      (state) => {
        if (state.status === "closing" || state.cancelSessions.length) {
          state.error = STILL_STOPPING;
          return;
        }
        const { active } = state;
        if (active) {
          const participant = state.participants[active.participant];
          abortMetadata.value = {
            messageId: active.messageId,
            model: participant.model,
            provider: participant.billing,
            sessionId: participant.sessionId,
            startedAt: active.startedAt,
            turnId: active.turnId,
          };
          const session = participant.sessionId;
          if (session) {
            requestCancel(state, session);
          }
        }
        archiveInterrupted(state);
        state.active = null;
        state.status = "paused";
        state.revision += 1;
        state.error =
          "Couldn't complete the response. Check the connection and continue.";
      },
      claim.token
    );
    const aborted = abortMetadata.value;
    if (saved && aborted) {
      observeOperation({
        durationMs: Math.max(0, Date.now() - Date.parse(aborted.startedAt)),
        entryPoint: "workflow",
        errorCode: operationErrorCode(error),
        flow: "fireside",
        model: aborted.model,
        operationId: aborted.messageId,
        outcome:
          error instanceof Error && error.message === "turn timeout"
            ? "timeout"
            : "failed",
        provider: aborted.provider,
        sessionId: aborted.sessionId,
        stage: "terminal",
        turnId: aborted.turnId,
      });
    }
    return false;
  } finally {
    await releaseFireside(id, claim.token);
  }
}

const POLL_MS = 2000;

/**
 * One step of the durable runner (H-32). Returns how long to wait before the next step, or `null`
 * when the runner stops: either another runner owns the fireside (nothing is touched), or there is
 * no work left and no wake arrived since the heartbeat.
 */
export async function runFiresideRunner(
  id: string,
  runId: string
): Promise<number | null> {
  const owned = await heartbeatRunner(id, runId);
  if (!owned) {
    return null;
  }
  const done = await firesideTick(id);
  if (done && (await idleRunner(id, runId, owned.wakes))) {
    return null;
  }
  const latest = await getFireside(id);
  const due = latest && nextCancelDelay(latest.state);
  // Only cancellations backing off: wait for the earliest one instead of polling every 2 s.
  const onlyBackoff =
    latest &&
    !latest.state.active &&
    !Object.values(latest.state.participants).some((p) => p.allocating);
  return onlyBackoff && due ? Math.max(POLL_MS, due) : POLL_MS;
}

export async function recoverFiresides() {
  const pending = await pendingFiresides();
  const { scheduleFireside } = await import("./schedule");
  await Promise.allSettled(pending.map((row) => scheduleFireside(row.id)));
  return { firesides: pending.length };
}
