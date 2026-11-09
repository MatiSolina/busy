import type { PublicCodeEvent, PublicCodeTask } from "./types";

export interface CodeTaskCheckpoint {
  detail?: string | null;
  elapsedSeconds: number | null;
  eventSeqs: number[];
  files: string[];
  id: string;
  kind:
    | "repository"
    | "tool"
    | "message"
    | "check"
    | "question"
    | "result"
    | "instruction";
  run: number;
  state: "running" | "completed" | "failed" | "cancelled" | "waiting";
  title: string;
}
export interface CodeTaskCheckpointSummary {
  checkpoints: CodeTaskCheckpoint[];
  runs: number;
}
const FILE_TOOL = /^(?:read|write|edit|patch|create|delete)_file$/u;
const WORKSPACE_PREFIX = /^\/workspace\/repo\//u;
const REPO_PREFIX = /^repo\//u;
const DOMAIN_TO_TOOL: Record<string, string[]> = {
  question: ["ask_user"],
  "repository.prepared": ["prepare_repository"],
  "task.ready": ["publish_changes", "finish_without_changes"],
  verification: ["run_verification"],
};
const TOOL_LABELS: Record<string, string> = {
  ask_user: "Ask for input",
  edit_file: "Edited file",
  finish_without_changes: "Finish without changes",
  prepare_repository: "Prepared repository",
  publish_changes: "Publish pull request",
  read_file: "Read file",
  run_verification: "Run verification",
  shell: "Run command",
  write_file: "Updated file",
};
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function repositoryPath(value: unknown): string | null {
  const input = text(value);
  return input &&
    !input.startsWith("/") &&
    !input
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part === ".git")
    ? input
    : null;
}
function toolPath(value: unknown): string | null {
  const input = text(value);
  if (!input) {
    return null;
  }
  return repositoryPath(
    input.startsWith("/workspace/repo/")
      ? input.replace(WORKSPACE_PREFIX, "")
      : input.replace(REPO_PREFIX, "")
  );
}
function files(data: Record<string, unknown>): string[] {
  return Array.isArray(data.files)
    ? [
        ...new Set(
          data.files.flatMap((value) => {
            const file = repositoryPath(value);
            return file ? [file] : [];
          })
        ),
      ]
    : [];
}
function toolInput(data: Record<string, unknown>): Record<string, unknown> {
  const command = text(data.command);
  if (!command) {
    return record(data.input);
  }
  try {
    return record(JSON.parse(command));
  } catch {
    return {};
  }
}
function elapsed(task: PublicCodeTask, event: PublicCodeEvent): number | null {
  const seconds =
    (Date.parse(event.createdAt) - Date.parse(task.createdAt)) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? Math.floor(seconds) : null;
}
function toolCheckpoint(
  data: Record<string, unknown>
): Pick<CodeTaskCheckpoint, "title" | "files" | "detail"> {
  const name = text(data.name) ?? "tool";
  const input = toolInput(data);
  const file = FILE_TOOL.test(name)
    ? toolPath(input.path ?? input.file_path ?? input.filename)
    : null;
  const command = text(input.command) ?? text(record(input.request).command);
  return {
    detail: text(data.output) ?? text(data.command),
    files: file ? [file] : files(data),
    title: file
      ? `${TOOL_LABELS[name] ?? name}: ${file.slice(file.lastIndexOf("/") + 1)}`
      : (command ?? TOOL_LABELS[name] ?? `Used ${name}`),
  };
}
function checkState(exitCode: unknown): CodeTaskCheckpoint["state"] {
  if (typeof exitCode !== "number") {
    return "waiting";
  }
  return exitCode === 0 ? "completed" : "failed";
}
function toolEndState(
  data: Record<string, unknown>
): CodeTaskCheckpoint["state"] {
  return data.isError === true ? "failed" : "completed";
}
function domainCheckpoint(event: PublicCodeEvent): Partial<CodeTaskCheckpoint> {
  const data = record(event.data);
  if (event.type === "verification") {
    return {
      detail: text(data.output),
      files: files(data),
      kind: "check",
      state: checkState(data.exitCode),
      title: text(data.command) ?? "Verification",
    };
  }
  if (event.type === "repository.prepared") {
    return {
      detail: text(data.root),
      files: files(data),
      kind: "repository",
      state: "completed",
      title: "Prepared repository",
    };
  }
  if (event.type === "task.ready") {
    return {
      detail: text(data.summary),
      files: files(data),
      kind: "result",
      state: "completed",
      title: data.noChanges
        ? "Finished without changes"
        : "Task ready for review",
    };
  }
  return {
    detail: text(data.question) ?? text(data.message),
    files: [],
    kind: "question",
    state: "waiting",
    title: "Waiting for your input",
  };
}
interface Projection {
  calls: Map<string, CodeTaskCheckpoint>;
  checkpoints: CodeTaskCheckpoint[];
  currentRun: number;
  names: Map<string, string>;
  pendingLegacy: Set<string>;
  runIds: Map<string, number>;
  starts: number;
}
function create(
  task: PublicCodeTask,
  event: PublicCodeEvent,
  run: number
): CodeTaskCheckpoint {
  return {
    elapsedSeconds: elapsed(task, event),
    eventSeqs: [event.seq],
    files: [],
    id: `checkpoint:${event.seq}`,
    kind: "message",
    run,
    state: "completed",
    title: "Agent update",
  };
}
function findCall(
  projection: Projection,
  event: PublicCodeEvent
): CodeTaskCheckpoint | undefined {
  const data = record(event.data);
  const id = text(data.callId);
  if (id) {
    return projection.calls.get(`${projection.currentRun}:${id}`);
  }
  const names = DOMAIN_TO_TOOL[event.type] ?? [text(data.name) ?? ""];
  const candidates = projection.checkpoints.filter(
    (checkpoint) =>
      checkpoint.run === projection.currentRun &&
      projection.pendingLegacy.has(checkpoint.id) &&
      names.includes(projection.names.get(checkpoint.id) ?? "")
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
function projectTool(
  task: PublicCodeTask,
  event: PublicCodeEvent,
  projection: Projection
) {
  const data = record(event.data);
  const existing = findCall(projection, event);
  const checkpoint = existing ?? create(task, event, projection.currentRun);
  if (existing) {
    checkpoint.eventSeqs.push(event.seq);
    if (checkpoint.kind === "tool" && event.type === "tool.end") {
      checkpoint.state = data.isError === true ? "failed" : "completed";
      checkpoint.detail = text(data.output) ?? checkpoint.detail;
    }
    if (event.type === "tool.end") {
      checkpoint.elapsedSeconds = elapsed(task, event);
    }
  } else {
    Object.assign(checkpoint, {
      kind: "tool",
      ...toolCheckpoint(data),
      state: event.type === "tool.start" ? "running" : toolEndState(data),
    });
    projection.checkpoints.push(checkpoint);
  }
  const callId = text(data.callId);
  if (callId) {
    projection.calls.set(`${projection.currentRun}:${callId}`, checkpoint);
  }
  projection.names.set(checkpoint.id, text(data.name) ?? "tool");
  if (event.type === "tool.start" && !callId) {
    projection.pendingLegacy.add(checkpoint.id);
  }
  if (event.type === "tool.end") {
    projection.pendingLegacy.delete(checkpoint.id);
  }
}
function projectDomain(
  task: PublicCodeTask,
  event: PublicCodeEvent,
  projection: Projection
) {
  const checkpoint =
    findCall(projection, event) ?? create(task, event, projection.currentRun);
  if (!projection.checkpoints.includes(checkpoint)) {
    projection.checkpoints.push(checkpoint);
  }
  if (!checkpoint.eventSeqs.includes(event.seq)) {
    checkpoint.eventSeqs.push(event.seq);
  }
  Object.assign(checkpoint, domainCheckpoint(event), {
    elapsedSeconds: elapsed(task, event),
  });
  const callId = text(record(event.data).callId);
  if (callId) {
    projection.calls.set(`${projection.currentRun}:${callId}`, checkpoint);
  }
}
function startRun(event: PublicCodeEvent, projection: Projection) {
  const data = record(event.data);
  const id = text(data.messageId);
  const known = id ? projection.runIds.get(id) : undefined;
  if (known) {
    projection.currentRun = known;
    return;
  }
  const resumed =
    data.resumed === true || data.message === "Resuming the saved task";
  if (resumed) {
    projection.starts = Math.max(projection.starts, projection.currentRun);
  } else {
    projection.starts += 1;
    projection.currentRun = Math.max(projection.starts, 1);
  }
  if (id) {
    projection.runIds.set(id, projection.currentRun);
  }
}
function finishRunning(projection: Projection, run: number, failed: boolean) {
  for (const checkpoint of projection.checkpoints) {
    if (checkpoint.run === run && checkpoint.state === "running") {
      checkpoint.state = failed ? "failed" : "cancelled";
      checkpoint.detail =
        checkpoint.detail ??
        "No completion was recorded before this run ended.";
    }
  }
}
function projectEvent(
  task: PublicCodeTask,
  event: PublicCodeEvent,
  projection: Projection
) {
  if (event.type === "agent.working") {
    startRun(event, projection);
    return;
  }
  if (event.type === "agent.turn_ended") {
    finishRunning(
      projection,
      projection.currentRun,
      event.data.stopReason === "error"
    );
    return;
  }
  if (event.type === "tool.start" || event.type === "tool.end") {
    projectTool(task, event, projection);
    return;
  }
  if (DOMAIN_TO_TOOL[event.type]) {
    projectDomain(task, event, projection);
    return;
  }
  const data = record(event.data);
  const message = text(data.message);
  if (
    !(
      message &&
      (event.type === "agent.message" || event.type === "instruction.applied")
    )
  ) {
    return;
  }
  if (
    event.type === "instruction.applied" &&
    message.trim() === task.goal.trim()
  ) {
    return;
  }
  const previous = projection.checkpoints.at(-1);
  if (
    event.type === "agent.message" &&
    previous?.kind === "message" &&
    previous.run === projection.currentRun
  ) {
    previous.title += message;
    previous.detail = previous.title;
    previous.eventSeqs.push(event.seq);
    previous.elapsedSeconds = elapsed(task, event);
    return;
  }
  projection.checkpoints.push({
    ...create(task, event, projection.currentRun),
    detail: message,
    kind: event.type === "instruction.applied" ? "instruction" : "message",
    title:
      event.type === "instruction.applied" ? "Updated instructions" : message,
  });
}
export function buildCodeTaskCheckpoints(
  task: PublicCodeTask,
  events: PublicCodeEvent[]
): CodeTaskCheckpointSummary {
  const projection: Projection = {
    calls: new Map(),
    checkpoints: [],
    currentRun: 1,
    names: new Map(),
    pendingLegacy: new Set(),
    runIds: new Map(),
    starts: 0,
  };
  const unique = new Map(events.map((event) => [event.seq, event]));
  for (const event of [...unique.values()].sort((a, b) => a.seq - b.seq)) {
    projectEvent(task, event, projection);
  }
  if (
    ["ready", "cancelled", "failed", "needs_attention"].includes(task.status)
  ) {
    for (let run = 1; run <= projection.currentRun; run += 1) {
      finishRunning(projection, run, task.status === "failed");
    }
  }
  return {
    checkpoints: projection.checkpoints,
    runs: projection.checkpoints.length
      ? Math.max(projection.starts, projection.currentRun)
      : 0,
  };
}
