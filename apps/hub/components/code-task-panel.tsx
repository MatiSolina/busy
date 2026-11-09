"use client";

import { Tabs } from "@base-ui/react/tabs";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Code2,
  FileDiff,
  Gauge,
  GitBranch,
  GitPullRequest,
  Loader2,
  OctagonX,
  PauseCircle,
  Send,
  Square,
  Terminal,
} from "lucide-react";
import { useCallback, useState } from "react";
import {
  CodeTaskActivity,
  CodeTaskChecks,
  CodeTaskResult,
} from "@/components/code-task-activity";
import { CodeTaskChanges } from "@/components/code-task-changes";
import { CodeTaskUsage } from "@/components/code-task-usage";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { useCodeTask } from "@/components/use-code-task";
import type {
  CodeTaskStatus,
  PublicCodeEvent as SharedPublicCodeEvent,
  PublicCodeTask as SharedPublicCodeTask,
} from "@/lib/code-tasks/types";

export type PublicCodeEvent = SharedPublicCodeEvent;
export type PublicCodeTask = SharedPublicCodeTask;

const ACTIVE_STATUSES = new Set<CodeTaskStatus>([
  "queued",
  "running",
  "waiting_for_input",
  "cancel_requested",
]);
const statusLabel: Record<CodeTaskStatus, string> = {
  cancel_requested: "Stopping",
  cancelled: "Cancelled",
  failed: "Failed",
  needs_attention: "Needs attention",
  queued: "Queued",
  ready: "Ready",
  running: "Working",
  waiting_for_input: "Waiting for you",
};
const statusClass: Record<CodeTaskStatus, string> = {
  cancel_requested: "bg-amber-500/10 text-amber-500",
  cancelled: "bg-muted text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
  needs_attention: "bg-destructive/10 text-destructive",
  queued: "bg-muted text-muted-foreground",
  ready: "bg-emerald-500/10 text-emerald-500",
  running: "bg-blue-500/10 text-blue-500",
  waiting_for_input: "bg-amber-500/10 text-amber-500",
};
const summaryStatusClass: Record<CodeTaskStatus, string> = {
  cancel_requested: "text-amber-700 dark:text-amber-400",
  cancelled: "text-muted-foreground",
  failed: "text-destructive",
  needs_attention: "text-destructive",
  queued: "text-muted-foreground",
  ready: "text-emerald-700 dark:text-emerald-400",
  running: "text-blue-600 dark:text-blue-400",
  waiting_for_input: "text-amber-700 dark:text-amber-400",
};

const taskTabs = [
  { icon: Activity, label: "Activity", value: "activity" },
  { icon: FileDiff, label: "Changes", value: "changes" },
  { icon: Terminal, label: "Checks", value: "checks" },
  { icon: GitPullRequest, label: "Result", value: "result" },
  { icon: Gauge, label: "Usage", value: "usage" },
] as const;

type CodeTaskTab = (typeof taskTabs)[number]["value"];

function StatusMark({ status }: { status: CodeTaskStatus }) {
  let Icon = Code2;
  if (status === "ready") {
    Icon = CheckCircle2;
  } else if (status === "failed" || status === "needs_attention") {
    Icon = CircleAlert;
  } else if (status === "cancelled") {
    Icon = OctagonX;
  } else if (status === "waiting_for_input") {
    Icon = PauseCircle;
  } else if (status === "running" || status === "cancel_requested") {
    Icon = Loader2;
  }
  return (
    <Icon
      aria-hidden="true"
      className={`size-3.5 ${status === "running" || status === "cancel_requested" ? "motion-safe:animate-spin" : ""}`}
    />
  );
}

export function CodeTaskSummaryCard({
  task,
  onOpen,
}: {
  task: Pick<
    PublicCodeTask,
    "id" | "title" | "repository" | "phase" | "status"
  >;
  onOpen: (taskId: string) => void;
}) {
  const handleOpen = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      const id = event.currentTarget.dataset.taskId;
      if (id) {
        onOpen(id);
      }
    },
    [onOpen]
  );
  return (
    <button
      className="group border-border bg-card/40 hover:border-foreground/20 hover:bg-muted/40 focus-visible:ring-ring focus-visible:ring-offset-background block w-full border p-4 text-left transition-colors focus-visible:ring-2 focus-visible:ring-offset-2"
      data-task-id={task.id}
      onClick={handleOpen}
      title={task.title}
      type="button"
    >
      <span className="flex items-center justify-between gap-4 text-xs">
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          <Code2 aria-hidden="true" className="size-3.5" />
          Code task
        </span>
        <span
          className={`inline-flex shrink-0 items-center gap-1.5 ${summaryStatusClass[task.status]}`}
        >
          <StatusMark status={task.status} />
          {statusLabel[task.status]}
        </span>
      </span>
      <span className="text-foreground mt-2.5 line-clamp-2 text-sm leading-5 font-medium">
        {task.title}
      </span>
      <span className="text-muted-foreground mt-3 flex items-center justify-between gap-4 text-[11px]">
        <span className="min-w-0 truncate font-mono">
          {task.repository.fullName}
          {task.phase ? ` · ${task.phase}` : ""}
        </span>
        <span className="group-hover:text-foreground group-focus-visible:text-foreground inline-flex shrink-0 items-center gap-1 transition-colors">
          {task.status === "ready" ? "View result" : "View task"}
          <ArrowUpRight aria-hidden="true" className="size-3.5" />
        </span>
      </span>
    </button>
  );
}

interface CodeTaskDetailProps {
  initialTab?: "activity" | "result";
  onOpenChange?: (open: boolean) => void;
  open: boolean;
  taskId: string | null;
}

export function CodeTaskDetail(props: CodeTaskDetailProps) {
  const lifecycleKey = `${props.taskId ?? "none"}:${props.open ? "open" : "closed"}`;
  return <CodeTaskDetailContent key={lifecycleKey} {...props} />;
}

function CodeTaskHeader({ task }: { task: PublicCodeTask | null }) {
  return (
    <DialogHeader className="shrink-0 gap-3 border-b px-5 pt-5 pb-4 sm:px-6">
      <div className="flex items-center gap-2 pr-8">
        <Code2
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <span className="text-muted-foreground text-xs">Coding task</span>
        {task ? (
          <span
            className={`ml-1 inline-flex items-center gap-1.5 px-2 py-1 text-[11px] ${statusClass[task.status]}`}
          >
            <StatusMark status={task.status} />
            {statusLabel[task.status]}
          </span>
        ) : null}
      </div>
      <DialogTitle className="pr-7 text-lg leading-snug font-medium sm:text-xl">
        {task?.title ?? "Code work"}
      </DialogTitle>
      <DialogDescription className="sr-only">
        Initial task, agent activity, changed files, verification, and usage.
      </DialogDescription>
      {task ? (
        <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Code2 aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="truncate">{task.repository.fullName}</span>
          </span>
          <span
            className="inline-flex min-w-0 items-center gap-1.5"
            title={task.branch ?? task.repository.baseBranch}
          >
            <GitBranch aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="max-w-52 truncate font-mono text-[11px] sm:max-w-96">
              {task.branch ?? task.repository.baseBranch}
            </span>
          </span>
          {task.prUrl ? (
            <a
              className="text-foreground focus-visible:ring-ring ml-auto inline-flex items-center gap-1.5 hover:underline focus-visible:ring-2"
              href={task.prUrl}
              rel="noreferrer"
              target="_blank"
            >
              <GitPullRequest aria-hidden="true" className="size-3.5" />
              View PR
            </a>
          ) : null}
        </div>
      ) : null}
    </DialogHeader>
  );
}

function CodeTaskDetailContent({
  initialTab = "activity",
  taskId,
  open,
  onOpenChange,
}: CodeTaskDetailProps) {
  const { task, events, error, sending, sendCommand } = useCodeTask({
    open,
    taskId,
  });
  const [instruction, setInstruction] = useState("");
  const [activeTab, setActiveTab] = useState<CodeTaskTab>(initialTab);
  const [requestedFile, setRequestedFile] = useState<string | null>(null);
  const openChanges = useCallback((path: string) => {
    setRequestedFile(path);
    setActiveTab("changes");
  }, []);
  const changeTab = useCallback((value: unknown) => {
    const selected = taskTabs.find((candidate) => candidate.value === value);
    if (selected) {
      setRequestedFile(null);
      setActiveTab(selected.value);
    }
  }, []);
  const focusChangesPanel = useCallback(
    (node: HTMLDivElement | null) => {
      if (node && requestedFile) {
        node.focus();
      }
    },
    [requestedFile]
  );
  const workspaceExpired = Boolean(
    task?.execution.workspaceExpiredAt || task?.execution.workspaceDeletedAt
  );
  const canSteer =
    task !== null &&
    !workspaceExpired &&
    (ACTIVE_STATUSES.has(task.status) ||
      task.status === "ready" ||
      task.status === "needs_attention");
  const canStop = task !== null && ACTIVE_STATUSES.has(task.status);
  const sendInstruction = useCallback(async () => {
    if (await sendCommand("steer", instruction.trim())) {
      setInstruction("");
    }
  }, [instruction, sendCommand]);
  const cancelTask = useCallback(() => {
    sendCommand("cancel").catch(() => undefined);
  }, [sendCommand]);
  const handleInstructionChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInstruction(event.target.value);
    },
    []
  );
  const noUpdateMessage = workspaceExpired
    ? "This task workspace has expired. Start a new task to continue."
    : "This task is no longer accepting updates.";

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="roomy:h-[min(52rem,calc(100dvh-3rem))] roomy:w-[calc(100vw-3rem)] roomy:max-w-6xl flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <CodeTaskHeader task={task} />
        {error ? (
          <p
            className="bg-destructive/10 text-destructive shrink-0 px-5 py-3 text-xs"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        {task ? (
          <Tabs.Root
            className="flex min-h-0 flex-1 flex-col"
            onValueChange={changeTab}
            value={activeTab}
          >
            <Tabs.List
              aria-label="Code task details"
              className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 sm:px-5"
            >
              {taskTabs.map(({ value, label, icon: Icon }) => (
                <Tabs.Tab
                  aria-label={value}
                  className="text-muted-foreground hover:text-foreground data-active:border-foreground data-active:text-foreground focus-visible:bg-muted flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-2.5 py-3 text-xs"
                  key={value}
                  value={value}
                >
                  <Icon aria-hidden="true" className="size-3.5" />
                  {label}
                </Tabs.Tab>
              ))}
            </Tabs.List>
            <Tabs.Panel
              className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
              value="activity"
            >
              <CodeTaskActivity
                events={events}
                onOpenChanges={openChanges}
                task={task}
              />
            </Tabs.Panel>
            <Tabs.Panel
              className="min-h-0 flex-1 overflow-hidden"
              ref={focusChangesPanel}
              value="changes"
            >
              <CodeTaskChanges
                initialPath={requestedFile}
                key={requestedFile ?? "all-files"}
                task={task}
              />
            </Tabs.Panel>
            <Tabs.Panel
              className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
              value="checks"
            >
              <CodeTaskChecks events={events} task={task} />
            </Tabs.Panel>
            <Tabs.Panel
              className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
              value="result"
            >
              <CodeTaskResult events={events} task={task} />
            </Tabs.Panel>
            <Tabs.Panel
              className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6"
              value="usage"
            >
              <CodeTaskUsage task={task} />
            </Tabs.Panel>
          </Tabs.Root>
        ) : (
          <p
            className="text-muted-foreground min-h-0 flex-1 p-6 text-sm"
            role="status"
          >
            {error ? "Task unavailable." : "Loading task…"}
          </p>
        )}
        <div className="shrink-0 border-t p-3 sm:px-5">
          {canSteer ? (
            <div className="flex items-end gap-2">
              <Textarea
                aria-label="Update code task"
                className="max-h-28 min-h-10 flex-1 resize-none text-sm"
                disabled={sending}
                maxLength={4000}
                onChange={handleInstructionChange}
                placeholder="Add an instruction for this task…"
                value={instruction}
              />
              {canStop ? (
                <Button
                  aria-label="Stop task"
                  disabled={sending || task?.status === "cancel_requested"}
                  onClick={cancelTask}
                  size="icon"
                  variant="ghost"
                >
                  <Square aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                aria-label="Send task update"
                disabled={sending || !instruction.trim()}
                onClick={sendInstruction}
                size="icon"
              >
                <Send aria-hidden="true" />
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground px-1 py-1 text-xs">
              {noUpdateMessage}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
