"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CodeTaskStatus,
  PublicCodeEvent,
  PublicCodeTask,
} from "@/lib/code-tasks/types";

const ACTIVE_STATUSES = new Set<CodeTaskStatus>([
  "queued",
  "running",
  "waiting_for_input",
  "cancel_requested",
]);

const TERMINAL_STATUSES = new Set<CodeTaskStatus>([
  "ready",
  "cancelled",
  "failed",
  "needs_attention",
]);

const COST_POLL_INTERVAL_MS = 5000;

interface DetailResponse {
  events: PublicCodeEvent[];
  hasMoreEvents?: boolean;
  task: PublicCodeTask;
}

export type CodeTaskCommandKind = "steer" | "cancel";

export interface UseCodeTaskResult {
  error: string | null;
  events: PublicCodeEvent[];
  sendCommand: (kind: CodeTaskCommandKind, text?: string) => Promise<boolean>;
  sending: boolean;
  task: PublicCodeTask | null;
}

function isTerminalStatus(status: CodeTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function mergeCodeTaskEvents(
  current: PublicCodeEvent[],
  incoming: PublicCodeEvent[]
): PublicCodeEvent[] {
  const bySequence = new Map<number, PublicCodeEvent>();
  for (const event of current) {
    bySequence.set(event.seq, event);
  }
  for (const event of incoming) {
    bySequence.set(event.seq, event);
  }
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

function eventCursor(events: PublicCodeEvent[]): number {
  return events.reduce((cursor, event) => Math.max(cursor, event.seq), 0);
}

function shouldApplyTaskSnapshot(
  next: PublicCodeTask,
  current: PublicCodeTask | null
): boolean {
  if (!current || next.id !== current.id) {
    return !current;
  }
  if (next.revision !== current.revision) {
    return next.revision > current.revision;
  }
  const nextTime = Date.parse(next.updatedAt);
  const currentTime = Date.parse(current.updatedAt);
  if (Number.isNaN(nextTime) || Number.isNaN(currentTime)) {
    return true;
  }
  return nextTime >= currentTime;
}

function errorMessage(body: unknown, fallback: string): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

async function requestJson<T>(
  url: string,
  init?: RequestInit,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(url, { ...init, signal });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(errorMessage(body, `Request failed (${response.status})`));
  }
  return body as T;
}

/**
 * Owns one code task's snapshot, event cursor, live stream, and steering
 * commands. Keeping this lifecycle outside the visual shell makes it possible
 * to present the same task in a modal, a route, or a compact inline card.
 */
export function useCodeTask({
  open,
  taskId,
}: {
  open: boolean;
  taskId: string | null;
}): UseCodeTaskResult {
  const [task, setTask] = useState<PublicCodeTask | null>(null);
  const [events, setEvents] = useState<PublicCodeEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [streamRevision, setStreamRevision] = useState(0);
  const highWaterRef = useRef(0);
  const taskRef = useRef<PublicCodeTask | null>(null);

  useEffect(() => {
    if (!(open && taskId)) {
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let stream: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const closeStream = () => {
      if (stream) {
        stream.close();
        stream = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer) {
        return;
      }
      const delay = Math.min(10_000, 1000 * 2 ** Math.min(attempt, 3));
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        openStream();
      }, delay);
    };

    const openStream = () => {
      if (cancelled) {
        return;
      }
      closeStream();
      const cursor = Math.max(0, highWaterRef.current);
      const nextStream = new EventSource(
        `/api/code-tasks/${encodeURIComponent(taskId)}/events?after=${cursor}&stream=${streamRevision}`
      );
      stream = nextStream;
      const onTask = (event: Event) => {
        try {
          const value = JSON.parse((event as MessageEvent).data) as
            | PublicCodeTask
            | { task: PublicCodeTask };
          const nextTask = "task" in value ? value.task : value;
          taskRef.current = nextTask;
          setTask(nextTask);
          if (isTerminalStatus(nextTask.status)) {
            attempt = 0;
          }
        } catch {
          // A reconnect will recover from the saved event cursor.
        }
      };
      const onEvent = (event: Event) => {
        try {
          const value = JSON.parse(
            (event as MessageEvent).data
          ) as PublicCodeEvent;
          if (value.seq <= highWaterRef.current) {
            return;
          }
          highWaterRef.current = value.seq;
          setEvents((current) => mergeCodeTaskEvents(current, [value]));
        } catch {
          // Keep the stream alive; the next reconnect catches up.
        }
      };
      const onEnd = () => {
        closeStream();
        if (!(taskRef.current && isTerminalStatus(taskRef.current.status))) {
          scheduleReconnect();
        }
      };
      nextStream.addEventListener("task", onTask);
      nextStream.addEventListener("event", onEvent);
      nextStream.addEventListener("end", onEnd);
      nextStream.onerror = () => {
        closeStream();
        scheduleReconnect();
      };
    };

    // Fetch every page before opening SSE. This avoids starting a live stream
    // at cursor 500 while older terminal-task events remain invisible.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Snapshot pagination and live-stream recovery intentionally share one cancellation boundary.
    const load = async () => {
      try {
        let cursor = 0;
        let nextTask: PublicCodeTask | null = null;
        let loaded: PublicCodeEvent[] = [];
        let hasMore = true;
        while (hasMore && !cancelled) {
          const query = cursor ? `?after=${cursor}` : "";
          // biome-ignore lint/performance/noAwaitInLoops: Pages must be fetched sequentially by cursor.
          const body = await requestJson<DetailResponse>(
            `/api/code-tasks/${encodeURIComponent(taskId)}${query}`,
            undefined,
            controller.signal
          );
          nextTask = body.task;
          loaded = mergeCodeTaskEvents(loaded, body.events);
          const nextCursor = eventCursor(loaded);
          if (nextCursor <= cursor) {
            hasMore = false;
          } else {
            cursor = nextCursor;
            hasMore = body.hasMoreEvents === true;
          }
        }
        if (cancelled || !nextTask) {
          return;
        }
        highWaterRef.current = eventCursor(loaded);
        taskRef.current = nextTask;
        setTask(nextTask);
        setEvents(loaded);
        setError(null);
        if (!isTerminalStatus(nextTask.status)) {
          openStream();
        }
      } catch (cause) {
        if (!(cancelled || controller.signal.aborted)) {
          setError(
            cause instanceof Error ? cause.message : "Couldn't load this task."
          );
        }
      }
    };

    load().catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      closeStream();
    };
  }, [open, streamRevision, taskId]);

  useEffect(() => {
    const taskStatus = task?.status;
    const costStatus = task?.usage?.costStatus;
    if (
      !(
        open &&
        taskId &&
        taskStatus &&
        isTerminalStatus(taskStatus) &&
        (costStatus === "pending" || costStatus === "partial")
      )
    ) {
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      if (!cancelled) {
        timer = setTimeout(() => {
          refresh().catch(() => undefined);
        }, COST_POLL_INTERVAL_MS);
      }
    };

    const refresh = async () => {
      try {
        const cursor = Math.max(0, highWaterRef.current);
        const body = await requestJson<DetailResponse>(
          `/api/code-tasks/${encodeURIComponent(taskId)}?after=${cursor}`,
          undefined,
          controller.signal
        );
        if (cancelled) {
          return;
        }
        const incoming = body.events;
        highWaterRef.current = Math.max(
          highWaterRef.current,
          cursor,
          eventCursor(incoming)
        );
        const previous = taskRef.current;
        if (shouldApplyTaskSnapshot(body.task, previous)) {
          taskRef.current = body.task;
          setTask(body.task);
          if (
            previous &&
            isTerminalStatus(previous.status) &&
            !isTerminalStatus(body.task.status)
          ) {
            setStreamRevision((value) => value + 1);
          }
        }
        if (incoming.length) {
          setEvents((current) => mergeCodeTaskEvents(current, incoming));
        }
      } catch {
        // Cost reconciliation may be delayed by the provider. Keep polling
        // until the task reports a terminal cost status or the view closes.
      }
      schedule();
    };

    schedule();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [open, task?.status, task?.usage?.costStatus, taskId]);

  const sendCommand = useCallback(
    async (kind: CodeTaskCommandKind, text?: string): Promise<boolean> => {
      if (!taskId || sending) {
        return false;
      }
      setSending(true);
      setError(null);
      try {
        const body = await requestJson<{ task?: PublicCodeTask | null }>(
          `/api/code-tasks/${encodeURIComponent(taskId)}/commands`,
          {
            body: JSON.stringify({
              id: crypto.randomUUID(),
              kind,
              ...(text ? { text } : {}),
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          }
        );
        if (kind === "steer") {
          const nextTask = body.task;
          if (nextTask) {
            highWaterRef.current = 0;
            taskRef.current = nextTask;
            setTask(nextTask);
            setEvents([]);
            setStreamRevision((value) => value + 1);
          }
        } else if (kind === "cancel") {
          setTask((current) =>
            current ? { ...current, status: "cancel_requested" } : current
          );
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Couldn't send the update."
        );
        throw cause;
      } finally {
        setSending(false);
      }
      return true;
    },
    [sending, taskId]
  );

  return { error, events, sendCommand, sending, task };
}

export { ACTIVE_STATUSES, isTerminalStatus };
