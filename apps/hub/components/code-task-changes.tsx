"use client";

import { AlertTriangle, FileCode2, FilePlus2, FileX2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { publicTaskDiff } from "@/lib/code-tasks/changes";
import type {
  CodeTaskDiff,
  CodeTaskDiffFile,
} from "@/lib/code-tasks/diff-types";
import type { PublicCodeTask } from "@/lib/code-tasks/types";

type CodeTaskChange = CodeTaskDiffFile;

type DiffLineKind = "add" | "context" | "meta" | "remove";

interface DiffLine {
  kind: DiffLineKind;
  newNumber: number | null;
  oldNumber: number | null;
  text: string;
}

const numberFormat = new Intl.NumberFormat("en-US");
const HUNK_HEADER = /^@@ -(?<old>\d+)(?:,\d+)? \+(?<new>\d+)(?:,\d+)? @@/u;

function parseHunkHeader(line: string): {
  newStart: number;
  oldStart: number;
} | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) {
    return null;
  }
  const oldStart = Number(match.groups?.old);
  const newStart = Number(match.groups?.new);
  return Number.isSafeInteger(oldStart) && Number.isSafeInteger(newStart)
    ? { newStart, oldStart }
    : null;
}

function nextContextLineNumber(value: number): number {
  return value > 0 ? value + 1 : value;
}

export function parseDiffLines(patch: string): DiffLine[] {
  let oldNumber = 0;
  let newNumber = 0;
  let hasHunk = false;
  const rawLines = patch.endsWith("\n")
    ? patch.slice(0, -1).split("\n")
    : patch.split("\n");
  return rawLines.map((rawLine): DiffLine => {
    const hunk = parseHunkHeader(rawLine);
    if (hunk) {
      oldNumber = hunk.oldStart;
      newNumber = hunk.newStart;
      hasHunk = true;
      return {
        kind: "meta",
        newNumber: null,
        oldNumber: null,
        text: rawLine,
      };
    }
    if (rawLine.startsWith("diff --git ")) {
      hasHunk = false;
    }
    if (!hasHunk || rawLine.startsWith("\\ No newline at end of file")) {
      return {
        kind: "meta",
        newNumber: null,
        oldNumber: null,
        text: rawLine,
      };
    }
    if (rawLine.startsWith("+")) {
      const line = {
        kind: "add" as const,
        newNumber,
        oldNumber: null,
        text: rawLine.slice(1),
      };
      newNumber += 1;
      return line;
    }
    if (rawLine.startsWith("-")) {
      const line = {
        kind: "remove" as const,
        newNumber: null,
        oldNumber,
        text: rawLine.slice(1),
      };
      oldNumber += 1;
      return line;
    }
    const text = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    const line = {
      kind: "context" as const,
      newNumber: newNumber > 0 ? newNumber : null,
      oldNumber: oldNumber > 0 ? oldNumber : null,
      text,
    };
    oldNumber = nextContextLineNumber(oldNumber);
    newNumber = nextContextLineNumber(newNumber);
    return line;
  });
}

function statusIcon(status: CodeTaskChange["status"]) {
  if (status === "added") {
    return <FilePlus2 aria-hidden="true" className="size-3.5" />;
  }
  if (status === "deleted") {
    return <FileX2 aria-hidden="true" className="size-3.5" />;
  }
  return <FileCode2 aria-hidden="true" className="size-3.5" />;
}

function statusLabel(status: CodeTaskChange["status"]): string {
  if (status === "added") {
    return "Added";
  }
  if (status === "deleted") {
    return "Deleted";
  }
  return "Modified";
}

function diffLineClass(kind: DiffLineKind): string {
  if (kind === "add") {
    return "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100";
  }
  if (kind === "remove") {
    return "bg-red-500/10 text-red-950 dark:text-red-100";
  }
  if (kind === "meta") {
    return "bg-muted/50 text-muted-foreground";
  }
  return "text-foreground";
}

function diffMarker(kind: DiffLineKind): string {
  if (kind === "add") {
    return "+";
  }
  if (kind === "remove") {
    return "−";
  }
  return " ";
}

function DiffViewer({ change }: { change: CodeTaskChange }) {
  if (!change.patch) {
    return (
      <div className="text-muted-foreground flex h-full min-h-48 items-center justify-center p-8 text-sm">
        <p>This file has no text patch. It may be binary or unavailable.</p>
      </div>
    );
  }
  const lines = parseDiffLines(change.patch);
  return (
    <div
      className="min-w-max border-t font-mono text-[11px] leading-5"
      data-testid="diff-viewer"
    >
      {lines.map((line) => (
        <div
          className={`grid min-w-max grid-cols-[3.25rem_3.25rem_1.25rem_minmax(0,1fr)] whitespace-pre ${diffLineClass(line.kind)}`}
          key={`${line.kind}:${line.oldNumber ?? "-"}:${line.newNumber ?? "-"}:${line.text}`}
        >
          <span
            className="text-muted-foreground border-r px-2 text-right tabular-nums select-none"
            data-line="old"
          >
            {line.oldNumber ?? ""}
          </span>
          <span
            className="text-muted-foreground border-r px-2 text-right tabular-nums select-none"
            data-line="new"
          >
            {line.newNumber ?? ""}
          </span>
          <span aria-hidden="true" className="px-1 text-center select-none">
            {diffMarker(line.kind)}
          </span>
          <code className="px-2">{line.text}</code>
        </div>
      ))}
    </div>
  );
}

function FileList({
  changes,
  selectedPath,
  onSelect,
}: {
  changes: CodeTaskChange[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const handleSelect = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { currentTarget } = event;
      const { dataset } = currentTarget;
      const { path } = dataset;
      if (path) {
        onSelect(path);
      }
    },
    [onSelect]
  );

  return (
    <nav
      aria-label="Changed files"
      className="flex max-h-44 shrink-0 gap-1 overflow-x-auto border-b p-2 sm:max-h-none sm:w-64 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-r sm:border-b-0 sm:p-3"
    >
      {changes.map((change) => (
        <button
          aria-label={change.path}
          aria-pressed={selectedPath === change.path}
          className={`group flex min-w-52 shrink-0 items-start gap-2 border-l-2 px-2.5 py-2 text-left text-xs transition-colors sm:min-w-0 ${
            selectedPath === change.path
              ? "border-foreground bg-muted text-foreground"
              : "text-muted-foreground hover:border-border hover:bg-muted/60 hover:text-foreground border-transparent"
          }`}
          data-path={change.path}
          key={change.path}
          onClick={handleSelect}
          type="button"
        >
          <span className="mt-0.5 shrink-0">{statusIcon(change.status)}</span>
          <span className="min-w-0 flex-1">
            <span
              className="block truncate font-mono text-[11px]"
              title={change.path}
            >
              {change.path.slice(change.path.lastIndexOf("/") + 1)}
            </span>
            <span className="text-muted-foreground mt-0.5 block truncate font-mono text-[10px]">
              {change.path.slice(0, Math.max(0, change.path.lastIndexOf("/")))}
            </span>
            <span className="text-muted-foreground mt-1 flex items-center gap-2 text-[10px]">
              <span>{statusLabel(change.status)}</span>
              <span className="text-emerald-600 dark:text-emerald-400">
                +{numberFormat.format(change.additions)}
              </span>
              <span className="text-red-600 dark:text-red-400">
                −{numberFormat.format(change.deletions)}
              </span>
            </span>
          </span>
        </button>
      ))}
    </nav>
  );
}

async function fetchChanges(
  taskId: string,
  signal: AbortSignal
): Promise<CodeTaskDiff> {
  const response = await fetch(
    `/api/code-tasks/${encodeURIComponent(taskId)}/diff`,
    { cache: "no-store", signal }
  );
  const remoteChanges = (await response
    .json()
    .catch(() => null)) as CodeTaskDiff | null;
  if (!(response.ok && remoteChanges && Array.isArray(remoteChanges.files))) {
    throw new Error("Changes are not available yet.");
  }
  return remoteChanges;
}

function resolveSelectedPath(
  files: CodeTaskDiffFile[],
  selected: string | null,
  initial: string | null
) {
  if (selected !== null && selected === initial) {
    return selected;
  }
  return files.some((file) => file.path === selected)
    ? selected
    : (files[0]?.path ?? null);
}

function MissingFileDiff({ path }: { path: string | null }) {
  return (
    <div className="text-muted-foreground p-6 text-sm">
      <p>
        {path
          ? "No current diff for this file."
          : "Select a file to view its diff."}
      </p>
      {path ? <p className="mt-2 font-mono text-xs break-all">{path}</p> : null}
    </div>
  );
}

export function CodeTaskChanges({
  task,
  initialPath = null,
}: {
  task: PublicCodeTask;
  initialPath?: string | null;
}) {
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath);
  const [remoteState, setRemoteState] = useState<{
    changes: CodeTaskDiff | null;
    key: string;
    warning: string | null;
  } | null>(null);
  const fallback = useMemo(() => publicTaskDiff(task), [task]);
  const snapshotKey = `${task.id}:${task.revision}:${task.updatedAt}`;

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const remoteChanges = await fetchChanges(task.id, controller.signal);
        if (!controller.signal.aborted) {
          setRemoteState({
            changes: remoteChanges,
            key: snapshotKey,
            warning: null,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setRemoteState({
            changes: null,
            key: snapshotKey,
            warning:
              error instanceof Error
                ? error.message
                : "Changes are not available yet.",
          });
        }
      }
    };
    load().catch(() => undefined);
    return () => controller.abort();
  }, [snapshotKey, task.id]);

  const changes =
    remoteState?.key === snapshotKey && remoteState.changes !== null
      ? remoteState.changes
      : fallback;
  const loading = remoteState?.key !== snapshotKey;
  const warning = remoteState?.key === snapshotKey ? remoteState.warning : null;
  const activePath = resolveSelectedPath(
    changes.files,
    selectedPath,
    initialPath
  );

  const selected = useMemo(
    () => changes.files.find((file) => file.path === activePath) ?? null,
    [activePath, changes.files]
  );
  const totals = useMemo(() => {
    if (!changes) {
      return { additions: 0, deletions: 0 };
    }
    return changes.files.reduce(
      (result, file) => ({
        additions: result.additions + file.additions,
        deletions: result.deletions + file.deletions,
      }),
      { additions: 0, deletions: 0 }
    );
  }, [changes]);

  if (!changes || changes.files.length === 0) {
    return (
      <div className="flex h-full min-h-48 flex-col items-center justify-center gap-3 p-8 text-center">
        <FileCode2
          aria-hidden="true"
          className="text-muted-foreground size-5"
        />
        <div>
          <p className="text-sm font-medium">No changed files yet</p>
          <p className="text-muted-foreground mt-1 max-w-sm text-xs leading-relaxed">
            {loading
              ? "Waiting for the agent to capture its workspace."
              : "The task has not recorded a text diff."}
          </p>
        </div>
        {warning ? (
          <p className="text-muted-foreground text-[11px]">{warning}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3 sm:px-5">
        <div className="flex items-center gap-3 text-xs">
          <span className="font-medium">
            {numberFormat.format(changes.files.length)}{" "}
            {changes.files.length === 1 ? "file" : "files"}
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{numberFormat.format(totals.additions)}
          </span>
          <span className="text-red-600 dark:text-red-400">
            −{numberFormat.format(totals.deletions)}
          </span>
          <span className="text-muted-foreground">
            {changes.source === "github" ? "Published PR" : "Workspace capture"}
          </span>
        </div>
        {changes.truncated ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
            <AlertTriangle aria-hidden="true" className="size-3.5" />
            Diff truncated
          </span>
        ) : null}
      </div>
      {warning ? (
        <p className="text-muted-foreground flex shrink-0 items-center gap-2 border-b px-4 py-2 text-[11px] sm:px-5">
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
          Showing the stored capture. {warning}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <FileList
          changes={changes.files}
          onSelect={setSelectedPath}
          selectedPath={activePath}
        />
        <section
          aria-label={selected ? `Diff for ${selected.path}` : "Diff viewer"}
          className="focus-visible:ring-ring min-h-0 min-w-0 flex-1 overflow-auto focus-visible:ring-1 focus-visible:ring-inset"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard focus lets arrow keys scroll the overflowing diff (WCAG 2.1.1).
          tabIndex={0}
        >
          {selected ? (
            <>
              <div className="bg-background sticky top-0 z-10 flex items-center justify-between gap-3 border-b px-4 py-3 sm:px-5">
                <p
                  className="min-w-0 font-mono text-xs leading-relaxed break-all"
                  title={selected.path}
                >
                  {selected.path}
                </p>
                <span className="text-muted-foreground shrink-0 text-[11px]">
                  {statusLabel(selected.status)} · +
                  {numberFormat.format(selected.additions)} −
                  {numberFormat.format(selected.deletions)}
                </span>
              </div>
              <DiffViewer change={selected} />
            </>
          ) : (
            <MissingFileDiff path={activePath} />
          )}
        </section>
      </div>
    </div>
  );
}
