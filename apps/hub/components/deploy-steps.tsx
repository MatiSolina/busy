"use client";

import { Check, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { DeployStep, DeployStepState } from "@/lib/bots/progress";
import { cn } from "@/lib/utils";

const STATE_TEXT: Record<DeployStepState, string> = {
  active: "in progress",
  done: "done",
  error: "failed",
  pending: "pending",
};

/** 7s, 1m 05s, 12m 40s. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes
    ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
    : `${seconds}s`;
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

const ICON_RING: Record<DeployStepState, string> = {
  active: "border-foreground/70 text-foreground",
  done: "border-emerald-500/40 bg-emerald-500/15 text-emerald-500",
  error: "border-destructive/40 bg-destructive/15 text-destructive",
  pending: "border-dashed border-muted-foreground/40",
};

function StepIcon({ state }: { state: DeployStepState }) {
  return (
    <span
      className={cn(
        "bg-background relative z-10 flex size-5 items-center justify-center rounded-full border",
        ICON_RING[state]
      )}
    >
      {state === "done" ? (
        <Check aria-hidden className="size-3" strokeWidth={3} />
      ) : null}
      {state === "error" ? (
        <X aria-hidden className="size-3" strokeWidth={3} />
      ) : null}
      {state === "active" ? (
        <LoaderCircle
          aria-hidden
          className="size-3 animate-spin motion-reduce:animate-none"
          strokeWidth={3}
        />
      ) : null}
    </span>
  );
}

function stepTime(step: DeployStep, now: number): string | null {
  if (!step.startedAt) {
    return null;
  }
  const start = Date.parse(step.startedAt);
  if (step.state === "active") {
    return formatElapsed(now - start);
  }
  return step.endedAt ? formatElapsed(Date.parse(step.endedAt) - start) : null;
}

/** The deploy's steps, refreshed by DeployWatcher's poll; the clock ticks here while a step runs. */
export function DeploySteps({ steps }: { steps: DeployStep[] }) {
  const running = steps.some((s) => s.state === "active");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return;
    }
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const current =
    steps.find((s) => s.state === "error") ??
    steps.find((s) => s.state === "active");
  return (
    <div className="w-full max-w-sm text-left">
      {/* Announces step changes only: the ticking timers below stay out of the live region. */}
      <p aria-live="polite" className="sr-only">
        {current ? `${current.label}: ${STATE_TEXT[current.state]}` : ""}
      </p>
      <ol aria-label="Deploy progress" className="flex flex-col">
        {steps.map((step, i) => {
          const time = stepTime(step, now);
          const last = i === steps.length - 1;
          return (
            <li
              className={cn(
                "relative flex gap-3 text-sm",
                !last && "pb-5",
                step.state === "pending" && "text-muted-foreground"
              )}
              data-state={step.state}
              key={step.id}
            >
              {last ? null : (
                <span
                  aria-hidden
                  className={cn(
                    "absolute top-5 bottom-0 left-2.5 w-px -translate-x-1/2",
                    step.state === "done" ? "bg-emerald-500/40" : "bg-border"
                  )}
                />
              )}
              <StepIcon state={step.state} />
              <div className="min-w-0 flex-1">
                <div className="flex h-5 items-center justify-between gap-3">
                  <span
                    className={cn(
                      step.state === "active" && "text-foreground font-medium"
                    )}
                  >
                    {step.label}
                    <span className="sr-only">{`, ${STATE_TEXT[step.state]}`}</span>
                  </span>
                  {time ? (
                    <span
                      className="text-muted-foreground shrink-0 font-mono text-xs tabular-nums"
                      title={
                        step.startedAt
                          ? `Started ${clock(step.startedAt)}`
                          : undefined
                      }
                    >
                      {time}
                    </span>
                  ) : null}
                </div>
                {step.detail ? (
                  <p
                    className={cn(
                      "mt-2 truncate rounded-md border px-2.5 py-1.5 font-mono text-xs",
                      step.state === "error"
                        ? "border-destructive/30 bg-destructive/10 text-destructive"
                        : "bg-muted/40 text-muted-foreground"
                    )}
                    title={step.detail}
                  >
                    {step.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
