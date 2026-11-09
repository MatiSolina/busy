"use client";

import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  Clock3,
  Code2,
  GitCommitHorizontal,
  GitPullRequest,
  Info,
  Loader2,
  MessageSquareText,
  Play,
  Terminal,
} from "lucide-react";
import { CodeTaskCheckpoints } from "@/components/code-task-checkpoints";
import type { PublicCodeEvent, PublicCodeTask } from "@/lib/code-tasks/types";

const SENSITIVE_KEY_PATTERN =
  /token|secret|password|credential|authorization|api.?key/iu;
const eventTimeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const EMPTY_JSON_PATTERN = /^\{\s*\}$|^\[\s*\]$/u;
const SAFE_USAGE_COUNT_KEYS = new Set([
  "cacheReadTokens",
  "cacheWriteTokens",
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "totalTokens",
]);

export interface CodeTaskPresentationProps {
  events: PublicCodeEvent[];
  task: PublicCodeTask;
}

type Data = Record<string, unknown>;

function isRecord(value: unknown): value is Data {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function eventData(event: PublicCodeEvent): Data {
  return isRecord(event.data) ? event.data : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function titleCase(value: string): string {
  return value
    .replace(/[._-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/(?<prefix>^|\s)\S/gu, (character) => character.toUpperCase());
}

function toolName(event: PublicCodeEvent): string | null {
  return stringValue(eventData(event).name);
}

function eventLabel(event: PublicCodeEvent): string {
  const tool = toolName(event);
  if (event.type === "tool.start") {
    return tool ? `Started ${tool}` : "Started tool";
  }
  if (event.type === "tool.end") {
    return tool ? `Finished ${tool}` : "Finished tool";
  }
  const labels: Record<string, string> = {
    "agent.message": "Agent update",
    "agent.turn_ended": "Turn finished",
    "agent.working": "Agent working",
    "command.accepted": "Instruction accepted",
    "cost.recorded": "Cost recorded",
    "cost.updated": "Cost updated",
    "instruction.applied": "Instruction received",
    question: "Waiting for input",
    "repository.prepared": "Repository prepared",
    "task.cancelled": "Task cancelled",
    "task.needs_attention": "Needs attention",
    "task.ready": "Task ready",
    "usage.recorded": "Usage recorded",
    verification: "Verification",
  };
  return labels[event.type] ?? titleCase(event.type);
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return eventTimeFormat.format(date);
}

function sensitiveKey(key: string, value: unknown): boolean {
  if (!SENSITIVE_KEY_PATTERN.test(key)) {
    return false;
  }
  return !(
    SAFE_USAGE_COUNT_KEYS.has(key) &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function safeValue(value: unknown, key = ""): unknown {
  if (sensitiveKey(key, value)) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => safeValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        safeValue(childValue, childKey),
      ])
    );
  }
  return value;
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text && !EMPTY_JSON_PATTERN.test(text) ? text : null;
  }
  try {
    const result = JSON.stringify(safeValue(value), null, 2);
    return result && result !== "{}" && result !== "[]" ? result : null;
  } catch {
    return null;
  }
}

function eventMessage(event: PublicCodeEvent): string | null {
  const data = eventData(event);
  for (const key of [
    "message",
    "summary",
    "detail",
    "question",
    "text",
    "content",
    "narration",
    "value",
  ]) {
    const value =
      key === "message" ||
      key === "text" ||
      key === "narration" ||
      key === "value"
        ? textValue(data[key])
        : stringValue(data[key]);
    if (value) {
      return value;
    }
  }
  if (event.type === "agent.turn_ended") {
    const reason = stringValue(data.stopReason);
    return reason
      ? `Stopped because the turn ${titleCase(reason).toLowerCase()}.`
      : null;
  }
  return null;
}

function remainingData(event: PublicCodeEvent): Data {
  const data = eventData(event);
  const omitted = new Set([
    "command",
    "detail",
    "input",
    "inputPreview",
    "isError",
    "message",
    "name",
    "output",
    "question",
    "summary",
    "text",
    "content",
    "narration",
    "value",
  ]);
  return Object.fromEntries(
    Object.entries(data).filter(([key, value]) => {
      if (omitted.has(key) || value === undefined || value === null) {
        return false;
      }
      if (typeof value === "string" && !value.trim()) {
        return false;
      }
      return true;
    })
  );
}

function coalesceAgentMessages(events: PublicCodeEvent[]): PublicCodeEvent[] {
  const result: PublicCodeEvent[] = [];
  for (const event of events) {
    const previous = result.at(-1);
    if (event.type !== "agent.message" || previous?.type !== event.type) {
      result.push(event);
      continue;
    }
    const previousMessage = textValue(eventData(previous).message);
    const currentMessage = textValue(eventData(event).message);
    if (previousMessage === null || currentMessage === null) {
      result.push(event);
      continue;
    }
    result[result.length - 1] = {
      ...previous,
      createdAt: event.createdAt,
      data: {
        ...eventData(previous),
        message: previousMessage + currentMessage,
      },
    };
  }
  return result;
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
  const text = jsonText(value);
  if (!text) {
    return null;
  }
  return (
    <details className="border-border/70 mt-2 border bg-black/5 px-2.5 py-2 dark:bg-white/[0.03]">
      <summary className="text-muted-foreground cursor-pointer text-[11px] font-medium">
        {label}
      </summary>
      <pre className="text-muted-foreground mt-2 max-h-56 overflow-auto font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </pre>
    </details>
  );
}

function ActivityIcon({ event }: { event: PublicCodeEvent }) {
  const data = eventData(event);
  if (event.type === "tool.start") {
    return <Play aria-hidden="true" className="size-3.5" />;
  }
  if (event.type === "tool.end") {
    return <Terminal aria-hidden="true" className="size-3.5" />;
  }
  if (event.type === "verification") {
    const exitCode = numberValue(data.exitCode);
    if (exitCode === 0) {
      return <CheckCircle2 aria-hidden="true" className="size-3.5" />;
    }
    if (exitCode === null) {
      return <Info aria-hidden="true" className="size-3.5" />;
    }
    return <CircleX aria-hidden="true" className="size-3.5" />;
  }
  if (event.type === "instruction.applied" || event.type === "question") {
    return <MessageSquareText aria-hidden="true" className="size-3.5" />;
  }
  if (event.type === "task.ready") {
    return <CheckCircle2 aria-hidden="true" className="size-3.5" />;
  }
  if (
    event.type === "task.needs_attention" ||
    event.type === "task.cancelled"
  ) {
    return <CircleAlert aria-hidden="true" className="size-3.5" />;
  }
  return <Info aria-hidden="true" className="size-3.5" />;
}

function ActivityEventRow({ event }: { event: PublicCodeEvent }) {
  const data = eventData(event);
  const message = eventMessage(event);
  const command = stringValue(data.command);
  const output = stringValue(data.output);
  const inputPreview = stringValue(data.inputPreview);
  const metadata = remainingData(event);
  const isError =
    data.isError === true ||
    (numberValue(data.exitCode) !== null && numberValue(data.exitCode) !== 0);
  return (
    <article className="relative flex gap-3 pb-4 last:pb-0">
      <div className="bg-background border-border text-muted-foreground z-10 flex size-7 shrink-0 items-center justify-center rounded-full border">
        <ActivityIcon event={event} />
      </div>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p
            className={`text-sm font-medium ${isError ? "text-destructive" : "text-foreground"}`}
          >
            {eventLabel(event)}
          </p>
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] tabular-nums">
            <Clock3 aria-hidden="true" className="size-3" />
            {formatTime(event.createdAt)}
          </span>
        </div>
        {message ? (
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {message}
          </p>
        ) : null}
        {event.type === "verification" && stringValue(data.command) ? (
          <p className="text-foreground mt-1 font-mono text-xs break-words">
            {stringValue(data.command)}
          </p>
        ) : null}
        {event.type === "tool.start" ? (
          <DetailBlock
            label="Show tool input"
            value={command ?? inputPreview}
          />
        ) : null}
        {event.type === "tool.end" ? (
          <DetailBlock
            label={isError ? "Show error output" : "Show tool output"}
            value={output}
          />
        ) : null}
        {event.type === "verification" ? (
          <DetailBlock label="Show check output" value={output} />
        ) : null}
        {event.type === "instruction.applied" ? (
          <DetailBlock label="Show instruction" value={message} />
        ) : null}
        {Object.keys(metadata).length ? (
          <DetailBlock label="Show event details" value={metadata} />
        ) : null}
        <p className="text-muted-foreground/70 mt-1 text-[10px]">
          #{event.seq}
        </p>
      </div>
    </article>
  );
}

export function CodeTaskActivity({
  task,
  events,
  onOpenChanges,
}: CodeTaskPresentationProps & { onOpenChanges?: (path: string) => void }) {
  const activityEvents = coalesceAgentMessages(events);
  const isTerminal = [
    "ready",
    "failed",
    "cancelled",
    "needs_attention",
  ].includes(task.status);
  return (
    <div className="space-y-4">
      <section className="border-border bg-muted/30 border p-3.5">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px] font-semibold tracking-[0.12em] uppercase">
          <Code2 aria-hidden="true" className="size-3.5" />
          Initial task
        </div>
        <p className="text-foreground mt-2 text-sm leading-relaxed break-words whitespace-pre-wrap">
          {task.goal}
        </p>
      </section>
      <CodeTaskCheckpoints
        events={events}
        onOpenChanges={onOpenChanges}
        task={task}
      />
      {activityEvents.length ? (
        <details
          className="border-border border-t pt-4"
          data-testid="code-task-transcript"
        >
          <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring cursor-pointer text-xs focus-visible:ring-1">
            All activity · {events.length} events
          </summary>
          <div className="relative mt-4 pl-0.5">
            <div className="border-border absolute top-4 bottom-4 left-[15px] border-l" />
            <div className="space-y-0">
              {activityEvents.map((event) => (
                <ActivityEventRow
                  event={event}
                  key={`${event.seq}:${event.type}`}
                />
              ))}
            </div>
          </div>
        </details>
      ) : (
        <p className="text-muted-foreground py-4 text-sm">
          {isTerminal
            ? "No activity was recorded."
            : "Waiting for agent activity…"}
        </p>
      )}
    </div>
  );
}

interface CheckReceipt {
  command: string;
  digest?: string;
  exitCode?: number;
  instructionVersion?: number;
  output?: string;
  source: string;
}

function checkReceipt(value: unknown, source: string): CheckReceipt | null {
  if (!isRecord(value)) {
    return null;
  }
  const command = stringValue(value.command);
  if (!command) {
    return null;
  }
  return {
    command,
    digest: stringValue(value.digest) ?? undefined,
    exitCode: numberValue(value.exitCode) ?? undefined,
    instructionVersion: numberValue(value.instructionVersion) ?? undefined,
    output: stringValue(value.output) ?? undefined,
    source,
  };
}

function checksFor(
  task: PublicCodeTask,
  events: PublicCodeEvent[]
): CheckReceipt[] {
  const receipts: CheckReceipt[] = [];
  const executionChecks = task.execution.checks;
  if (Array.isArray(executionChecks)) {
    for (const value of executionChecks) {
      const receipt = checkReceipt(value, "task");
      if (receipt) {
        receipts.push(receipt);
      }
    }
  }
  for (const event of events) {
    const data = eventData(event);
    const likelyCheck =
      event.type === "verification" ||
      (stringValue(data.command) && numberValue(data.exitCode) !== null);
    if (!likelyCheck) {
      continue;
    }
    const receipt = checkReceipt(data, "activity");
    if (receipt) {
      receipts.push(receipt);
    }
  }
  const byIdentity = new Map<string, CheckReceipt>();
  for (const receipt of receipts) {
    byIdentity.set(checkIdentity(receipt), receipt);
  }
  return [...byIdentity.values()];
}

function checkIdentity(receipt: CheckReceipt): string {
  return [
    receipt.command,
    receipt.digest ?? "",
    receipt.exitCode ?? "",
    receipt.instructionVersion ?? "",
  ].join("\u0000");
}

function CheckStatus({ exitCode }: { exitCode?: number }) {
  if (exitCode === 0) {
    return (
      <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-500" />
    );
  }
  if (exitCode === undefined) {
    return <Info aria-hidden="true" className="text-muted-foreground size-4" />;
  }
  return <CircleX aria-hidden="true" className="text-destructive size-4" />;
}

export function CodeTaskChecks({ task, events }: CodeTaskPresentationProps) {
  const receipts = checksFor(task, events);
  if (!receipts.length) {
    return (
      <p className="text-muted-foreground text-sm">No checks recorded yet.</p>
    );
  }
  const passed = receipts.filter((receipt) => receipt.exitCode === 0).length;
  const failed = receipts.filter(
    (receipt) => receipt.exitCode !== undefined && receipt.exitCode !== 0
  ).length;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">
        {passed ? `${passed} passed` : "No passing checks"}
        {failed ? ` · ${failed} failed` : ""}
      </p>
      <div className="space-y-2">
        {receipts.map((receipt) => (
          <div
            className="border-border flex gap-3 border p-3"
            key={checkIdentity(receipt)}
          >
            <div className="pt-0.5">
              <CheckStatus exitCode={receipt.exitCode} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-foreground font-mono text-xs break-words">
                {receipt.command}
              </p>
              <p className="text-muted-foreground mt-1 text-[11px]">
                {receipt.exitCode === undefined
                  ? "Exit code unavailable"
                  : `Exit ${receipt.exitCode}`}
                {receipt.instructionVersion === undefined
                  ? ""
                  : ` · instruction v${receipt.instructionVersion}`}
              </p>
              {receipt.digest ? (
                <p className="text-muted-foreground mt-1 truncate font-mono text-[10px]">
                  {receipt.digest}
                </p>
              ) : null}
              <DetailBlock label="Show check output" value={receipt.output} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function resultEventData(events: PublicCodeEvent[]): Data {
  for (const event of [...events].reverse()) {
    if (
      ["task.ready", "task.needs_attention", "task.cancelled"].includes(
        event.type
      )
    ) {
      return eventData(event);
    }
  }
  return {};
}

function statusLabel(status: PublicCodeTask["status"]): string {
  const labels: Record<PublicCodeTask["status"], string> = {
    cancel_requested: "Stopping",
    cancelled: "Cancelled",
    failed: "Failed",
    needs_attention: "Needs attention",
    queued: "Queued",
    ready: "Ready",
    running: "Working",
    waiting_for_input: "Waiting for you",
  };
  return labels[status];
}

function ResultStatusIcon({
  error,
  status,
}: {
  error: string | null;
  status: PublicCodeTask["status"];
}) {
  if (status === "ready") {
    return (
      <CheckCircle2 aria-hidden="true" className="size-4 text-emerald-500" />
    );
  }
  if (error) {
    return (
      <CircleAlert aria-hidden="true" className="text-destructive size-4" />
    );
  }
  return (
    <Loader2 aria-hidden="true" className="text-muted-foreground size-4" />
  );
}

export function CodeTaskResult({ task, events }: CodeTaskPresentationProps) {
  const event = resultEventData(events);
  const summary = task.summary ?? stringValue(event.summary);
  const pullRequestUrl = task.prUrl ?? stringValue(event.pullRequestUrl);
  const commitSha = task.commitSha ?? stringValue(event.commitSha);
  const isResult = Boolean(
    summary ||
      pullRequestUrl ||
      commitSha ||
      task.error ||
      ["ready", "failed", "cancelled", "needs_attention"].includes(task.status)
  );
  if (!isResult) {
    return (
      <p className="text-muted-foreground text-sm">No result recorded yet.</p>
    );
  }
  return (
    <div className="space-y-4">
      <div className="border-border flex items-start gap-3 border p-3.5">
        <div className="bg-muted flex size-8 shrink-0 items-center justify-center rounded-full">
          <ResultStatusIcon error={task.error} status={task.status} />
        </div>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-medium">
            {statusLabel(task.status)}
          </p>
          {summary ? (
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {summary}
            </p>
          ) : null}
          {task.error ? (
            <p className="text-destructive mt-2 text-sm leading-relaxed">
              {task.error}
            </p>
          ) : null}
        </div>
      </div>
      {pullRequestUrl ? (
        <a
          className="border-border hover:bg-muted/40 inline-flex w-full items-center gap-2 border px-3 py-2.5 text-sm transition-colors"
          href={pullRequestUrl}
          rel="noreferrer"
          target="_blank"
        >
          <GitPullRequest aria-hidden="true" className="size-4" />
          Open draft pull request
        </a>
      ) : null}
      {commitSha ? (
        <div className="border-border flex items-start gap-2 border px-3 py-2.5">
          <GitCommitHorizontal
            aria-hidden="true"
            className="text-muted-foreground mt-0.5 size-4 shrink-0"
          />
          <code className="text-muted-foreground text-xs break-all">
            {commitSha}
          </code>
        </div>
      ) : null}
      {event.noChanges === true ? (
        <p className="text-muted-foreground text-xs">
          The agent completed the task without changing files.
        </p>
      ) : null}
    </div>
  );
}
