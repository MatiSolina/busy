import {
  type PlanStep,
  parseTaskPlan,
  type TaskPlan,
} from "../../../../templates/bot/agent/lib/task-plan";

export const RECOVERY_PACKET_VERSION = 1 as const;
export const RECOVERY_CONTEXT_KEY = "recovery";
export const MAX_RECOVERY_EVENTS = 2000;
export const MAX_RECOVERY_CONVERSATION = 24;
export const MAX_RECOVERY_TOOLS = 48;
export const MAX_RECOVERY_TEXT = 1200;
export const MAX_RECOVERY_PACKET_BYTES = 18_000;
const MAX_RECOVERY_HISTORY_IDS = 256;
const MAX_RECOVERY_MESSAGE_IDS = 64;
const ROOT_PLAN_TOOLS = new Set([
  "bind_plan_execution",
  "dispatch_plan_step",
  "manage_plan",
]);

export type RecoveryToolStatus = "started" | "completed" | "failed" | "unknown";

export interface RecoveryFileMetadata {
  mediaType?: string;
  name?: string;
  size?: number;
}

export interface RecoveryToolSummary {
  callId: string;
  files?: RecoveryFileMetadata[];
  name: string;
  status: RecoveryToolStatus;
}

export interface RecoveryConversationItem {
  at: string;
  id: string;
  role: "assistant" | "user";
  sessionId: string | null;
  text: string;
}

export interface RecoveryPlan {
  id: string;
  revision: number;
  steps: Array<{
    assignee: string;
    dependsOn: string[];
    id: string;
    status: PlanStep["status"];
    taskId?: string;
    title: string;
  }>;
  title: string;
}

export interface RecoveryPacket {
  actions: {
    completed: string[];
    started: string[];
    unknown: string[];
  };
  conversation: RecoveryConversationItem[];
  generatedAt: string;
  history: {
    eventIds: string[];
    messageIds: string[];
  };
  plan?: RecoveryPlan;
  sourceSessionId: string | null;
  tools: RecoveryToolSummary[];
  version: typeof RECOVERY_PACKET_VERSION;
}

export interface RecoveryEvent {
  at: Date | string;
  data: unknown;
  index: number;
  line: number;
  sessionId: string;
  type: string;
}

export interface RecoveryConversationSource {
  at: Date | string;
  id: string;
  role: "assistant" | "user";
  sessionId: string | null;
  text: string;
}

/** Return the root plan call ids present in an authenticated event slice. */
export function rootPlanCallIds(
  eventsRows: readonly RecoveryEvent[]
): string[] {
  const callIds = new Set<string>();
  for (const row of eventsRows) {
    const { data, scope } = factData(row.data);
    const callId = safeIdentifier(
      data.callId ?? object(data.startedBy)?.callId
    );
    const name = safeIdentifier(object(data.capability)?.name, 200);
    const rootRequest =
      row.type === "call.requested" &&
      scope.taskId === undefined &&
      name !== null &&
      ROOT_PLAN_TOOLS.has(name);
    if (callId && (rootRequest || callIds.has(callId))) {
      callIds.add(callId);
    }
  }
  return [...callIds];
}

/** Merge bounded and directed event reads before reducing a root plan. */
export function mergeRootPlanEvents(
  ...eventGroups: readonly (readonly RecoveryEvent[])[]
): RecoveryEvent[] {
  const rows = new Map<string, RecoveryEvent>();
  for (const group of eventGroups) {
    for (const row of group) {
      rows.set(`${row.sessionId}:${row.line}:${row.index}`, row);
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.line - right.line ||
      left.index - right.index ||
      new Date(left.at).getTime() - new Date(right.at).getTime()
  );
}

/** Do not carry a historical root plan into a session with no proven predecessor. */
export function withoutUnprovenPlan(packet: RecoveryPacket): RecoveryPacket {
  return { ...packet, plan: undefined };
}

interface ToolObservation extends RecoveryToolSummary {
  settled?: boolean;
  started?: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, max = MAX_RECOVERY_TEXT): string {
  if (typeof value !== "string") {
    return "";
  }
  const clean = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
  return clean
    .replace(
      /\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/giu,
      "$1: [redacted]"
    )
    .replace(
      /\b(?:Bearer\s+|sk-|rk-|ghp_|xoxb-)[A-Za-z0-9._-]{8,}/gu,
      "[redacted]"
    )
    .slice(0, max)
    .trim();
}

function safeIdentifier(value: unknown, max = 200): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return Array.from(value)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .slice(0, max);
}

function factData(value: unknown): {
  data: Record<string, unknown>;
  scope: Record<string, unknown>;
} {
  const record = object(value) ?? {};
  return {
    data: object(record.data) ?? record,
    scope: object(record.scope) ?? {},
  };
}

function safeFileMetadata(value: unknown): RecoveryFileMetadata[] | undefined {
  const root = object(value);
  if (!root) {
    return undefined;
  }
  const candidates = ["files", "file", "artifacts"].flatMap((key) => {
    const candidate = root[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
    if (candidate === undefined) {
      return [];
    }
    return [candidate];
  });
  const files = candidates.flatMap((candidate) => {
    const file = object(candidate);
    if (!file) {
      return [];
    }
    const name = safeIdentifier(file.name ?? file.filename, 200);
    const mediaType = safeIdentifier(file.mediaType ?? file.contentType, 120);
    const size =
      typeof file.size === "number" &&
      Number.isSafeInteger(file.size) &&
      file.size >= 0
        ? file.size
        : undefined;
    return name || mediaType || size !== undefined
      ? [
          {
            ...(name ? { name } : {}),
            ...(mediaType ? { mediaType } : {}),
            ...(size === undefined ? {} : { size }),
          },
        ]
      : [];
  });
  return files.length ? files.slice(0, 8) : undefined;
}

function safePlan(plan: TaskPlan): RecoveryPlan {
  return {
    id: plan.id,
    revision: plan.revision,
    steps: plan.steps.map((step) => ({
      assignee: boundedText(step.assignee, 100),
      dependsOn: step.dependsOn.slice(0, 20),
      id: step.id,
      status: step.status,
      ...(step.taskId ? { taskId: boundedText(step.taskId, 200) } : {}),
      title: boundedText(step.title, 240),
    })),
    title: boundedText(plan.title, 200),
  };
}

function planFromToolOutput(value: unknown): TaskPlan | null {
  const record = object(value);
  return record ? parseTaskPlan(record) : null;
}

function markUncertainDispatch(
  plan: TaskPlan,
  toolName: string,
  input: Record<string, unknown>
): TaskPlan {
  const { planId, revision, stepId } = input;
  if (
    planId !== plan.id ||
    revision !== plan.revision ||
    typeof stepId !== "string"
  ) {
    return plan;
  }
  if (!plan.steps.some((step) => step.id === stepId)) {
    return plan;
  }
  const knownDispatches =
    plan.dispatchCount ??
    plan.steps.filter((step) => step.execution !== undefined).length;
  return {
    ...plan,
    dispatchCount: Math.min(20, knownDispatches + 1),
    revision: plan.revision + 1,
    steps: plan.steps.map((step) =>
      step.id === stepId
        ? {
            ...step,
            note:
              toolName === "bind_plan_execution"
                ? "A plan execution binding was requested before the session ended; inspect it before retrying."
                : "A delegated dispatch was requested before the session ended; inspect it before retrying.",
            status: "blocked" as const,
          }
        : step
    ),
  };
}

interface RootPlanEventInfo {
  callId: string | null;
  data: Record<string, unknown>;
  input: Record<string, unknown> | null;
  name: string | null;
}

interface RootPlanCall {
  input: Record<string, unknown> | null;
  name: string;
  observedTaskId?: string;
}

function rootPlanEventInfo(
  row: RecoveryEvent,
  calls: ReadonlyMap<string, RootPlanCall>
): RootPlanEventInfo | null {
  const { data, scope } = factData(row.data);
  const capability = object(data.capability);
  const input = object(data.input);
  const callId = safeIdentifier(data.callId ?? object(data.startedBy)?.callId);
  const name = safeIdentifier(capability?.name, 200);
  const tracked = callId !== null && calls.has(callId);
  const requested =
    row.type === "call.requested" && name !== null && ROOT_PLAN_TOOLS.has(name);
  if (
    (scope.taskId !== undefined && !tracked) ||
    capability?.kind === "agent" ||
    (typeof input?.taskId === "string" && !tracked && !requested)
  ) {
    return null;
  }
  return { callId, data, input, name };
}

function registerRootPlanCall(
  info: RootPlanEventInfo,
  calls: Map<string, RootPlanCall>
): RootPlanCall | undefined {
  if (!(info.callId && info.name && ROOT_PLAN_TOOLS.has(info.name))) {
    return undefined;
  }
  const call = { input: info.input, name: info.name };
  calls.set(info.callId, call);
  return call;
}

function applyRootPlanLifecycleEvent(
  latest: TaskPlan | null,
  row: RecoveryEvent,
  info: RootPlanEventInfo,
  calls: ReadonlyMap<string, RootPlanCall>
): TaskPlan | null {
  const call = info.callId ? calls.get(info.callId) : undefined;
  if (
    call?.name === "dispatch_plan_step" &&
    (row.type === "call.started" || row.type === "task.started") &&
    typeof info.data.taskId === "string"
  ) {
    call.observedTaskId = info.data.taskId;
    if (!latest) {
      return null;
    }
    return attachObservedTaskId(latest, call.input, info.data.taskId);
  }
  if (
    row.type !== "call.settled" ||
    !call ||
    info.data.outcome !== "completed"
  ) {
    return latest;
  }
  const plan = planFromToolOutput(info.data.output);
  if (!plan) {
    return latest;
  }
  const observedPlan = call.observedTaskId
    ? attachObservedTaskId(plan, call.input, call.observedTaskId)
    : plan;
  return adoptPlanSnapshot(latest, observedPlan, call);
}

function attachObservedTaskId(
  plan: TaskPlan,
  input: Record<string, unknown> | null,
  taskId: string
): TaskPlan {
  const planId = input?.planId;
  const stepId = input?.stepId;
  if (planId !== plan.id || typeof stepId !== "string") {
    return plan;
  }
  if (!plan.steps.some((step) => step.id === stepId)) {
    return plan;
  }
  return {
    ...plan,
    steps: plan.steps.map((step) => {
      if (step.id !== stepId) {
        return step;
      }
      if (
        step.taskId === taskId &&
        (step.execution === undefined || step.execution.taskId === taskId)
      ) {
        return step;
      }
      if (step.status === "cancelled" || step.status === "completed") {
        return {
          ...step,
          execution: step.execution
            ? { ...step.execution, taskId }
            : step.execution,
          ...(step.taskId ? {} : { taskId }),
        };
      }
      return {
        ...step,
        execution: step.execution
          ? { ...step.execution, taskId }
          : step.execution,
        note:
          step.note ??
          "A delegated task was observed before the session ended; inspect it before retrying.",
        status: "blocked" as const,
        taskId,
      };
    }),
  };
}

function adoptPlanSnapshot(
  current: TaskPlan | null,
  candidate: TaskPlan,
  call: RootPlanCall
): TaskPlan {
  if (!current) {
    return candidate;
  }
  const observedByStep = new Map(
    current.steps.map((step) => [
      step.id,
      step.taskId ?? step.execution?.taskId,
    ])
  );
  const candidateWithObservedTaskIds = {
    ...candidate,
    steps: candidate.steps.map((step) => {
      const observedTaskId = observedByStep.get(step.id);
      if (!observedTaskId) {
        return step;
      }
      const execution = step.execution
        ? {
            ...step.execution,
            ...(step.execution.taskId ? {} : { taskId: observedTaskId }),
          }
        : step.execution;
      if (step.taskId === observedTaskId && execution === step.execution) {
        return step;
      }
      return {
        ...step,
        ...(step.taskId ? {} : { taskId: observedTaskId }),
        ...(execution ? { execution } : {}),
      };
    }),
  };
  const adoptedCandidate = candidateWithObservedTaskIds;
  let requestedPlanId: string | undefined;
  if (typeof call.input?.planId === "string") {
    requestedPlanId = call.input.planId;
  } else if (
    call.name === "manage_plan" &&
    typeof call.input?.id === "string"
  ) {
    requestedPlanId = call.input.id;
  }
  if (requestedPlanId && requestedPlanId !== current.id) {
    return current;
  }
  if (
    adoptedCandidate.id === current.id &&
    adoptedCandidate.revision < current.revision
  ) {
    return current;
  }
  if (adoptedCandidate.id !== current.id && requestedPlanId) {
    return current;
  }
  if (call.name !== "manage_plan") {
    const candidateById = new Map(
      adoptedCandidate.steps.map((step) => [step.id, step])
    );
    if (
      current.steps.some((step) => {
        if (step.status !== "cancelled" && step.status !== "completed") {
          return false;
        }
        const incoming = candidateById.get(step.id);
        return (
          incoming !== undefined &&
          incoming.status !== "cancelled" &&
          incoming.status !== "completed"
        );
      })
    ) {
      return current;
    }
  }
  return adoptedCandidate;
}

function observeTool(
  tools: Map<string, ToolObservation>,
  row: RecoveryEvent
): RecoveryPlan | null {
  const { data, scope } = factData(row.data);
  const capability = object(data.capability);
  const input = object(data.input);
  if (
    scope.taskId !== undefined ||
    capability?.kind === "agent" ||
    typeof input?.taskId === "string"
  ) {
    return null;
  }
  const callId = safeIdentifier(data.callId);
  if (!callId) {
    return null;
  }
  if (row.type === "call.requested") {
    const name = safeIdentifier(capability?.name, 200);
    if (name) {
      tools.set(callId, { callId, name, status: "unknown" });
    }
    return null;
  }
  const tool = tools.get(callId);
  if (!tool) {
    return null;
  }
  if (row.type === "call.started") {
    tool.started = true;
    if (tool.status === "unknown") {
      tool.status = "started";
    }
    return null;
  }
  if (row.type !== "call.settled") {
    return null;
  }
  tool.settled = true;
  const outcome = safeIdentifier(data.outcome, 40);
  if (outcome === "completed") {
    tool.status = "completed";
    tool.files = safeFileMetadata(data.output);
    if (tool.name === "manage_plan") {
      const plan = parseTaskPlan(data.output);
      return plan ? safePlan(plan) : null;
    }
  } else if (["failed", "cancelled", "interrupted"].includes(outcome ?? "")) {
    tool.status = "failed";
  } else {
    tool.status = "unknown";
  }
  return null;
}

/** The immutable full plan used by recovery APIs; never place this in prompt context. */
export function latestRootPlanSnapshot(
  eventsRows: readonly RecoveryEvent[],
  inheritedPlan: TaskPlan | null = null
): TaskPlan | null {
  let latest: TaskPlan | null = inheritedPlan;
  const rootPlanCalls = new Map<string, RootPlanCall>();
  for (const row of eventsRows) {
    const info = rootPlanEventInfo(row, rootPlanCalls);
    if (!info) {
      continue;
    }
    if (row.type === "call.requested") {
      const call = registerRootPlanCall(info, rootPlanCalls);
      if (latest && call?.input) {
        latest = markUncertainDispatch(latest, call.name, call.input);
      }
      continue;
    }
    latest = applyRootPlanLifecycleEvent(latest, row, info, rootPlanCalls);
  }
  return latest;
}

function summariesOf(
  tools: Map<string, ToolObservation>
): RecoveryToolSummary[] {
  return [...tools.values()]
    .slice(-MAX_RECOVERY_TOOLS)
    .map(({ callId, files, name, status }) => ({
      callId,
      ...(files ? { files } : {}),
      name,
      status,
    }));
}

function conversationOf(
  rows: readonly RecoveryConversationSource[]
): RecoveryConversationItem[] {
  return rows
    .map((item) => ({
      at: new Date(item.at).toISOString(),
      id: item.id,
      role: item.role,
      sessionId: item.sessionId,
      text: boundedText(item.text),
    }))
    .filter((item) => item.text)
    .sort((left, right) => left.at.localeCompare(right.at))
    .slice(-MAX_RECOVERY_CONVERSATION);
}

function trimPacketOnce(packet: RecoveryPacket): boolean {
  if (packet.conversation.length > 0) {
    packet.conversation.shift();
    return true;
  }
  if (packet.tools.length > 0) {
    packet.tools.shift();
    return true;
  }
  if (packet.actions.unknown.length > 0) {
    packet.actions.unknown.shift();
    return true;
  }
  if (packet.actions.started.length > 0) {
    packet.actions.started.shift();
    return true;
  }
  if (packet.actions.completed.length > 0) {
    packet.actions.completed.shift();
    return true;
  }
  if (packet.history.eventIds.length > 32) {
    packet.history.eventIds = packet.history.eventIds.slice(-32);
    return true;
  }
  if (packet.history.eventIds.length > 0) {
    packet.history.eventIds.shift();
    return true;
  }
  if (packet.history.messageIds.length > 8) {
    packet.history.messageIds = packet.history.messageIds.slice(-8);
    return true;
  }
  if (packet.history.messageIds.length > 0) {
    packet.history.messageIds.shift();
    return true;
  }
  if (packet.plan && packet.plan.steps.length > 1) {
    packet.plan.steps = packet.plan.steps.slice(0, 1);
    return true;
  }
  if (packet.plan) {
    packet.plan = undefined;
    return true;
  }
  return false;
}

function trimPacket(packet: RecoveryPacket): void {
  const bytes = () => Buffer.byteLength(JSON.stringify(packet), "utf8");
  let packetBytes = bytes();
  while (packetBytes > MAX_RECOVERY_PACKET_BYTES) {
    if (!trimPacketOnce(packet)) {
      break;
    }
    const nextBytes = bytes();
    if (nextBytes >= packetBytes) {
      break;
    }
    packetBytes = nextBytes;
  }
  if (packetBytes > MAX_RECOVERY_PACKET_BYTES) {
    throw new Error("Recovery packet exceeds its byte bound.");
  }
}

/** Build a safe bounded packet from already persisted facts and conversation. */
export function buildRecoveryPacket(
  eventsRows: readonly RecoveryEvent[],
  conversationRows: readonly RecoveryConversationSource[],
  sourceSessionId: string | null,
  generatedAt = new Date(),
  trustedPlan?: TaskPlan
): RecoveryPacket {
  const tools = new Map<string, ToolObservation>();
  let plan: RecoveryPlan | undefined;
  for (const row of eventsRows) {
    const candidate = observeTool(tools, row);
    if (candidate) {
      plan = candidate;
    }
  }
  const projectedPlan = trustedPlan ?? latestRootPlanSnapshot(eventsRows);
  if (projectedPlan) {
    plan = safePlan(projectedPlan);
  }
  const summaries = summariesOf(tools);
  const packet: RecoveryPacket = {
    actions: {
      completed: summaries
        .filter((tool) => tool.status === "completed")
        .map((tool) => tool.callId),
      started: summaries
        .filter((tool) => tool.status !== "unknown")
        .map((tool) => tool.callId),
      unknown: summaries
        .filter((tool) => tool.status === "unknown")
        .map((tool) => tool.callId),
    },
    conversation: conversationOf(conversationRows),
    generatedAt: generatedAt.toISOString(),
    history: {
      eventIds: eventsRows
        .slice(-MAX_RECOVERY_HISTORY_IDS)
        .map((row) => `${row.sessionId}:${row.line}:${row.index}`),
      messageIds: conversationRows
        .filter((row) => row.role === "user")
        .map((row) => row.id)
        .slice(-MAX_RECOVERY_MESSAGE_IDS),
    },
    ...(plan ? { plan } : {}),
    sourceSessionId,
    tools: summaries,
    version: RECOVERY_PACKET_VERSION,
  };
  trimPacket(packet);
  return packet;
}
