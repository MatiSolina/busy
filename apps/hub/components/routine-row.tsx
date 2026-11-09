"use client";

import { Menu } from "@base-ui/react/menu";
import { LoaderCircle, Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useCallback } from "react";
import { sanitizeAiRoutineMessage } from "@/lib/ai/errors";
import { routineScheduleLabel } from "@/lib/routines/display";
import type { PublicRoutine, PublicRoutineRun } from "@/lib/routines/types";
import { cn } from "@/lib/utils";

const menuItemClass =
  "flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50 [&_svg]:size-4";

export const safeRoutineRunError = sanitizeAiRoutineMessage;

function runStatus(run: PublicRoutineRun | null): {
  detail: string | null;
  label: string;
  tone: "default" | "destructive" | "running";
} | null {
  if (!run) {
    return null;
  }
  switch (run.status) {
    case "pending":
    case "dispatched":
      if (run.awaitingInputSince) {
        return {
          detail: "Answer the bot in its chat so the routine can continue.",
          label: "Waiting for you",
          tone: "default",
        };
      }
      return {
        detail: "Busy is working on it.",
        label: "Running now",
        tone: "running",
      };
    case "succeeded":
      return { detail: null, label: "Last run completed", tone: "default" };
    case "cancelled":
      return {
        detail:
          run.error === "The routine was cancelled."
            ? run.error
            : "The last run was cancelled.",
        label: "Last run cancelled",
        tone: "default",
      };
    case "failed":
      return {
        detail: safeRoutineRunError(run.error),
        label: "Last run failed",
        tone: "destructive",
      };
    default:
      return null;
  }
}

/** A schedule fired while the latest run still held the routine's only slot. */
function skippedWhileOpen(routine: PublicRoutine): boolean {
  const run = routine.lastRun;
  const lastSkip = routine.skipped?.lastAt;
  return Boolean(
    run &&
      (run.status === "pending" || run.status === "dispatched") &&
      lastSkip &&
      Date.parse(lastSkip) > Date.parse(run.scheduledFor)
  );
}

export function RoutineRow({
  routine,
  busy,
  disabled,
  onToggle,
  onEdit,
  onDelete,
}: {
  routine: PublicRoutine;
  busy: boolean;
  disabled: boolean;
  onToggle: (routine: PublicRoutine) => void;
  onEdit: (routine: PublicRoutine) => void;
  onDelete: (routine: PublicRoutine) => void;
}) {
  const toggle = useCallback(() => onToggle(routine), [onToggle, routine]);
  const edit = useCallback(() => onEdit(routine), [onEdit, routine]);
  const remove = useCallback(() => onDelete(routine), [onDelete, routine]);

  return (
    <li className="flex items-center gap-3 px-4">
      <Menu.Root>
        <Menu.Trigger
          aria-label={`Options for ${routine.name}`}
          className="hover:bg-foreground/5 -ml-4 min-w-0 flex-1 rounded-lg px-4 py-4 text-left outline-none"
          disabled={disabled}
        >
          <span className="block truncate text-base">{routine.name}</span>
          <span className="text-muted-foreground mt-0.5 block text-sm">
            {routine.enabled
              ? routineScheduleLabel(routine.daysOfWeek, routine.time)
              : "Paused"}
          </span>
          {(() => {
            const status = runStatus(routine.lastRun);
            if (!status) {
              return null;
            }
            return (
              <span
                className={cn(
                  "mt-1 block text-xs leading-relaxed",
                  status.tone === "destructive" && "text-destructive",
                  status.tone === "running" && "text-shimmer"
                )}
              >
                <span className="font-medium">{status.label}</span>
                {status.detail ? ` · ${status.detail}` : null}
                {skippedWhileOpen(routine)
                  ? " A later scheduled run was skipped while this one is open."
                  : null}
              </span>
            );
          })()}
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner align="start" className="z-50" sideOffset={4}>
            <Menu.Popup className="border-border bg-popover text-popover-foreground w-52 max-w-[calc(100vw-2rem)] rounded-xl border p-1.5 shadow-xl outline-none">
              <Menu.Item className={menuItemClass} onClick={toggle}>
                {routine.enabled ? (
                  <Pause aria-hidden="true" />
                ) : (
                  <Play aria-hidden="true" />
                )}
                {routine.enabled ? "Pause" : "Resume"}
              </Menu.Item>
              <Menu.Item className={menuItemClass} onClick={edit}>
                <Pencil aria-hidden="true" />
                Edit
              </Menu.Item>
              <Menu.Separator className="bg-border mx-2 my-1.5 h-px" />
              <Menu.Item
                className={cn(menuItemClass, "text-destructive")}
                onClick={remove}
              >
                <Trash2 aria-hidden="true" />
                Delete
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <button
        aria-busy={busy}
        aria-checked={routine.enabled}
        aria-label={routine.name}
        className="flex h-11 w-12 shrink-0 items-center outline-none disabled:opacity-50"
        disabled={disabled}
        onClick={toggle}
        role="switch"
        type="button"
      >
        <span
          className={cn(
            "flex h-7 w-12 items-center rounded-none p-0.5 transition-colors motion-reduce:transition-none",
            routine.enabled ? "bg-blue-600" : "bg-foreground/15"
          )}
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-none bg-white text-neutral-500 shadow-sm transition-transform motion-reduce:transition-none",
              routine.enabled && "translate-x-5"
            )}
          >
            {busy ? (
              <LoaderCircle
                aria-hidden="true"
                className="size-3.5 animate-spin"
              />
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
