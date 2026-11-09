"use client";

import {
  CheckCheck,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  MessageSquareText,
  Terminal,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import {
  buildCodeTaskCheckpoints,
  type CodeTaskCheckpoint,
} from "@/lib/code-tasks/checkpoints";
import type { PublicCodeEvent, PublicCodeTask } from "@/lib/code-tasks/types";

const costFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 4,
  style: "currency",
});
const EMPTY_JSON = /^\{\s*\}$|^\[\s*\]$/u;
const kindIcons = {
  check: CheckCheck,
  instruction: ClipboardList,
  message: MessageSquareText,
  question: CircleHelp,
  repository: FolderGit2,
  result: GitPullRequest,
  tool: Terminal,
};
const stateLabels = {
  cancelled: "Stopped",
  completed: "Completed",
  failed: "Failed",
  running: "Running",
  waiting: "Waiting",
};

function elapsed(value: number | null) {
  if (value === null) {
    return "—";
  }
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function CheckpointRail({
  checkpoint,
  previous,
  last,
}: {
  checkpoint: CodeTaskCheckpoint;
  previous?: CodeTaskCheckpoint;
  last: boolean;
}) {
  const x = checkpoint.run % 2 === 0 ? 19 : 8;
  const previousX = previous?.run && previous.run % 2 === 0 ? 19 : 8;
  const stopped =
    checkpoint.state === "cancelled" || checkpoint.state === "failed";
  return (
    <div aria-hidden="true" className="relative w-7 shrink-0">
      {previous ? (
        <svg
          aria-hidden="true"
          className="absolute top-0 left-0 h-[18px] w-7 overflow-visible text-blue-400/70"
          viewBox="0 0 28 18"
        >
          <path
            d={`M ${previousX} 0 C ${previousX} 9 ${x} 9 ${x} 18`}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      ) : null}
      {last ? null : (
        <span
          className="absolute top-[18px] bottom-0 w-px bg-blue-400/70"
          style={{ left: x }}
        />
      )}
      <svg
        aria-hidden="true"
        className={`absolute top-[14px] z-10 size-2 ${stopped ? "text-muted-foreground" : "text-blue-400"}`}
        style={{ left: x - 4 }}
        viewBox="0 0 8 8"
      >
        <circle
          cx="4"
          cy="4"
          fill={stopped ? "var(--background)" : "currentColor"}
          r="3"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </svg>
    </div>
  );
}

function CheckpointRow({
  checkpoint,
  previous,
  last,
  onOpenChanges,
}: {
  checkpoint: CodeTaskCheckpoint;
  previous?: CodeTaskCheckpoint;
  last: boolean;
  onOpenChanges?: (path: string) => void;
}) {
  const Icon = kindIcons[checkpoint.kind];
  const [firstFile] = checkpoint.files;
  const openFile = useCallback(() => {
    if (firstFile) {
      onOpenChanges?.(firstFile);
    }
  }, [firstFile, onOpenChanges]);
  const newRun = checkpoint.run > 1 && previous?.run !== checkpoint.run;
  const status = checkpoint.state;
  const hasDetail = Boolean(
    checkpoint.detail?.trim() && !EMPTY_JSON.test(checkpoint.detail.trim())
  );
  return (
    <li className="flex gap-2" data-checkpoint-state={status}>
      <CheckpointRail checkpoint={checkpoint} last={last} previous={previous} />
      <div className="flex min-w-0 flex-1 items-start gap-2.5 py-2">
        <span className="border-border bg-muted/30 text-muted-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center border">
          <Icon aria-hidden="true" className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {hasDetail ? (
              <details className="group/checkpoint min-w-0 flex-1 basis-40">
                <summary className="hover:text-foreground focus-visible:bg-muted flex cursor-pointer list-none items-start gap-1 text-[13px] leading-5 break-words [&::-webkit-details-marker]:hidden">
                  <ChevronRight
                    aria-hidden="true"
                    className="text-muted-foreground mt-1 size-3 shrink-0 group-open/checkpoint:rotate-90"
                  />
                  <span className="line-clamp-2 min-w-0">
                    {checkpoint.title}
                  </span>
                </summary>
                <pre className="text-muted-foreground mt-2 max-h-44 overflow-auto border-l pl-3 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                  {checkpoint.detail}
                </pre>
              </details>
            ) : (
              <p className="min-w-0 flex-1 text-[13px] leading-5 break-words">
                {checkpoint.title}
              </p>
            )}
            {newRun ? (
              <span className="bg-muted text-muted-foreground shrink-0 px-1.5 py-0.5 text-[10px]">
                Run {checkpoint.run}
              </span>
            ) : null}
          </div>
          {status === "completed" ? null : (
            <span
              className={`mt-0.5 block text-[10px] ${status === "failed" ? "text-red-400" : "text-muted-foreground"}`}
            >
              {stateLabels[status]}
            </span>
          )}
        </div>
        {firstFile ? (
          <button
            aria-label={`View latest diff for ${firstFile}`}
            className="text-muted-foreground hover:text-foreground focus-visible:bg-muted mt-1 inline-flex shrink-0 items-center gap-1 text-[11px] disabled:cursor-default"
            disabled={!onOpenChanges}
            onClick={openFile}
            title={`View latest diff for ${firstFile}`}
            type="button"
          >
            <FolderOpen aria-hidden="true" className="size-3" />
            <span>
              {checkpoint.files.length}{" "}
              <span className="hidden sm:inline">
                {checkpoint.files.length === 1 ? "file" : "files"}
              </span>
            </span>
          </button>
        ) : null}
        <span className="text-muted-foreground mt-1 w-10 shrink-0 text-right font-mono text-[11px] tabular-nums">
          <span className="sr-only">Elapsed </span>
          {elapsed(checkpoint.elapsedSeconds)}
        </span>
      </div>
    </li>
  );
}

function CostSummary({ task }: { task: PublicCodeTask }) {
  const { usage } = task;
  if (
    !(
      usage &&
      (usage.costStatus === "reported" || usage.costStatus === "partial") &&
      typeof usage.costUsd === "number" &&
      Number.isFinite(usage.costUsd)
    )
  ) {
    return null;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true">·</span>
      {usage.costStatus === "partial" ? "Partial " : ""}
      {costFormat.format(usage.costUsd)}
    </span>
  );
}

export function CodeTaskCheckpoints({
  task,
  events,
  onOpenChanges,
}: {
  task: PublicCodeTask;
  events: PublicCodeEvent[];
  onOpenChanges?: (path: string) => void;
}) {
  const summary = useMemo(
    () => buildCodeTaskCheckpoints(task, events),
    [task, events]
  );
  if (!summary.checkpoints.length) {
    return null;
  }
  return (
    <section aria-label="Task checkpoints" className="border-border border">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3.5 py-3">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <GitBranch
            aria-hidden="true"
            className="text-muted-foreground size-3.5"
          />
          Checkpoints
        </h3>
        <p
          className="text-muted-foreground hidden min-w-0 flex-1 truncate text-xs sm:block"
          title={task.title}
        >
          {task.title}
        </p>
        <div className="text-muted-foreground ml-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] tabular-nums">
          <span>{summary.checkpoints.length} checkpoints</span>
          <span aria-hidden="true">·</span>
          <span>
            {summary.runs} {summary.runs === 1 ? "run" : "runs"}
          </span>
          <CostSummary task={task} />
        </div>
      </header>
      <ol className="px-2.5 py-2 sm:px-3.5">
        {summary.checkpoints.map((checkpoint, index) => (
          <CheckpointRow
            checkpoint={checkpoint}
            key={checkpoint.id}
            last={index === summary.checkpoints.length - 1}
            onOpenChanges={onOpenChanges}
            previous={summary.checkpoints[index - 1]}
          />
        ))}
      </ol>
    </section>
  );
}
