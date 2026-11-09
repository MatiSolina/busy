"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CodeTaskDetail,
  CodeTaskSummaryCard,
} from "@/components/code-task-panel";
import { Button } from "@/components/ui/button";
import type {
  CodeTaskStatus,
  PublicCodeTaskSummary,
} from "@/lib/code-tasks/types";

const ACTIVE = new Set<CodeTaskStatus>([
  "queued",
  "running",
  "waiting_for_input",
  "cancel_requested",
]);
const RESUMABLE = new Set<CodeTaskStatus>(["ready", "needs_attention"]);

function pollingDelay(status: CodeTaskStatus): number | null {
  if (ACTIVE.has(status)) {
    return 10_000;
  }
  if (RESUMABLE.has(status)) {
    return 30_000;
  }
  return null;
}

async function readTask(slug: string, taskId: string, signal: AbortSignal) {
  const response = await fetch(
    `/api/code-tasks/${encodeURIComponent(taskId)}?view=summary`,
    { cache: "no-store", signal }
  );
  if (!response.ok) {
    throw new Error("Task unavailable");
  }
  const { task } = (await response.json()) as { task?: PublicCodeTaskSummary };
  if (!task || task.id !== taskId || (task.botSlug && task.botSlug !== slug)) {
    throw new Error("Invalid task response");
  }
  return task;
}

export function InlineCodeTaskCard(props: { slug: string; taskId: string }) {
  return <TaskCardState key={`${props.slug}:${props.taskId}`} {...props} />;
}

function TaskCardState({ slug, taskId }: { slug: string; taskId: string }) {
  const [task, setTask] = useState<PublicCodeTaskSummary | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry and closing the detail request a fresh summary for the same task.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      let delay: number | null = null;
      try {
        const next = await readTask(slug, taskId, controller.signal);
        if (!controller.signal.aborted) {
          setTask(next);
          setError(false);
          delay = pollingDelay(next.status);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError(true);
          delay = 30_000;
        }
      }
      if (!controller.signal.aborted && delay !== null) {
        timer = setTimeout(() => load().catch(() => undefined), delay);
      }
    };
    load().catch(() => undefined);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [revision, slug, taskId]);

  const openTask = useCallback(() => setOpen(true), []);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const changeOpen = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setRevision((value) => value + 1);
    }
  }, []);

  return (
    <div className="w-full max-w-md">
      {task ? (
        <CodeTaskSummaryCard onOpen={openTask} task={task} />
      ) : (
        <p className="text-muted-foreground px-4 py-3 text-sm" role="status">
          {error ? "Coding task" : "Loading coding task…"}
        </p>
      )}
      {error ? (
        <div className="flex items-center justify-between gap-3 px-4 py-2">
          <p className="text-muted-foreground text-xs" role="alert">
            Couldn&apos;t refresh this task.
          </p>
          <Button onClick={retry} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}
      <CodeTaskDetail
        initialTab={task?.status === "ready" ? "result" : "activity"}
        onOpenChange={changeOpen}
        open={open}
        taskId={taskId}
      />
    </div>
  );
}
