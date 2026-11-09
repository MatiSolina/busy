"use client";

import { Circle, GraduationCap, Loader2, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Live's Teach: while the user has control, records what they do on the bot's screen
 * (app/api/bots/[slug]/teach). Stop sends the bot a message asking it to learn the recording.
 */
export function TeachControl({
  slug,
  canStart,
  onDone,
}: {
  slug: string;
  canStart: boolean;
  /** Without it (no chat to send to) there is no Teach control. */
  onDone?: (message: string) => void;
}) {
  const endpoint = `/api/bots/${encodeURIComponent(slug)}/teach`;
  const [recording, setRecording] = useState<{
    id: string;
    since: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!recording) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    const res = await fetch(endpoint, { method: "POST" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      id?: string;
      error?: string;
    } | null;
    setBusy(false);
    if (res?.ok && body?.id) {
      setRecording({ id: body.id, since: Date.now() });
      setNow(Date.now());
    } else {
      setError(body?.error ?? "Couldn't start recording.");
    }
  }, [endpoint]);

  const stop = useCallback(async () => {
    if (!recording) {
      return;
    }
    setBusy(true);
    setError(null);
    const res = await fetch(endpoint, {
      body: JSON.stringify({ id: recording.id }),
      headers: { "Content-Type": "application/json" },
      method: "DELETE",
    }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as {
      message?: string;
      error?: string;
    } | null;
    setBusy(false);
    if (res?.ok && body?.message) {
      setRecording(null);
      onDone?.(body.message);
    } else {
      setError(body?.error ?? "Couldn't stop recording. Try again.");
    }
  }, [endpoint, onDone, recording]);

  if (!(onDone && (recording || canStart))) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2 self-start">
      {recording ? (
        <>
          <span
            className="text-destructive flex items-center gap-1.5 text-xs font-medium tabular-nums"
            role="status"
          >
            <Circle aria-hidden="true" className="size-2.5 fill-current" />
            Recording {clock(now - recording.since)}
          </span>
          <Button disabled={busy} onClick={stop} size="sm" variant="outline">
            {busy ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Square aria-hidden="true" />
            )}
            Stop teaching
          </Button>
        </>
      ) : (
        <Button
          disabled={busy}
          onClick={start}
          size="sm"
          title="Record what you do so it can learn it"
          variant="outline"
        >
          {busy ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <GraduationCap aria-hidden="true" />
          )}
          Teach
        </Button>
      )}
      {error ? (
        <span className="text-destructive text-xs" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
