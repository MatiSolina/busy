import type { Billing } from "../bots/models";

export const CODE_TASK_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "ready",
  "cancel_requested",
  "cancelled",
  "failed",
  "needs_attention",
] as const;
export type CodeTaskStatus = (typeof CODE_TASK_STATUSES)[number];

export const CODE_TASK_COMMAND_KINDS = ["start", "steer", "cancel"] as const;
export type CodeTaskCommandKind = (typeof CODE_TASK_COMMAND_KINDS)[number];

export const CODE_TASK_COMMAND_STATUSES = [
  "queued",
  "leased",
  "accepted",
  "applied",
  "settled",
  "failed",
] as const;
export type CodeTaskCommandStatus = (typeof CODE_TASK_COMMAND_STATUSES)[number];

export type CodeTaskPhase =
  | "preparing"
  | "inspecting"
  | "editing"
  | "checking"
  | "publishing"
  | "waiting"
  | "recovering"
  | null;

export interface CodeTaskAiSnapshot {
  agentName?: string;
  billing: Billing;
  fast: boolean;
  model: string;
}

/**
 * Provider-reported usage accumulated across the turns of a coding task.
 * Nullable counters mean that the provider has not reported that dimension.
 * Gateway charges are reconciled by generation ID. Subscription transports
 * and older tasks may have no separate, attributable USD amount.
 */
export type CodeTaskCostStatus =
  | "included"
  | "unavailable"
  | "pending"
  | "partial"
  | "reported";

export interface CodeTaskGenerationCost {
  gatewayCost: number | null;
  marketCost: number | null;
  surchargeCost: number | null;
  totalCost: number;
}

export interface CodeTaskGenerationCostInput {
  gatewayCost?: number | null;
  generationId: string;
  marketCost?: number | null;
  surchargeCost?: number | null;
  totalCost: number;
}

export interface PublicCodeTaskUsage {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costStatus: CodeTaskCostStatus;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requests: number;
}

export interface CodeTaskUsageTotals {
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  costStatus?: CodeTaskCostStatus;
  costUsd?: number | null;
  generationCosts?: Record<string, CodeTaskGenerationCost>;
  generationIds?: string[];
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  requests: number;
}

const USAGE_COUNTERS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly (keyof Omit<CodeTaskUsageTotals, "requests">)[];

function usageCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function addUsageCount(
  current: number | null | undefined,
  next: number | null
): number | null {
  if (next === null) {
    return current ?? null;
  }
  return (current ?? 0) + next;
}

/** Merge one libfx turn's optional usage object into persisted totals. */
export function mergeCodeTaskUsage(
  current: Partial<CodeTaskUsageTotals> | null | undefined,
  reported: Record<string, unknown> | null | undefined
): CodeTaskUsageTotals {
  const next = current ?? {};
  const merged = {
    cacheReadTokens: next.cacheReadTokens ?? null,
    cacheWriteTokens: next.cacheWriteTokens ?? null,
    inputTokens: next.inputTokens ?? null,
    outputTokens: next.outputTokens ?? null,
    reasoningTokens: next.reasoningTokens ?? null,
    requests: next.requests ?? 0,
    ...(next.costStatus ? { costStatus: next.costStatus } : {}),
    ...(next.costUsd === undefined ? {} : { costUsd: next.costUsd }),
    ...(next.generationCosts ? { generationCosts: next.generationCosts } : {}),
    ...(next.generationIds ? { generationIds: next.generationIds } : {}),
  } satisfies CodeTaskUsageTotals;
  if (!reported) {
    return merged;
  }
  const normalized = Object.fromEntries(
    USAGE_COUNTERS.map((key) => [key, usageCount(reported[key])])
  ) as Record<(typeof USAGE_COUNTERS)[number], number | null>;
  if (!USAGE_COUNTERS.some((key) => normalized[key] !== null)) {
    return merged;
  }
  for (const key of USAGE_COUNTERS) {
    merged[key] = addUsageCount(merged[key], normalized[key]);
  }
  merged.requests += 1;
  return merged;
}

export function publicCodeTaskUsage(
  totals: Partial<CodeTaskUsageTotals> | null | undefined,
  billing: Billing
): PublicCodeTaskUsage {
  return {
    cacheReadTokens: totals?.cacheReadTokens ?? null,
    cacheWriteTokens: totals?.cacheWriteTokens ?? null,
    costStatus:
      totals?.costStatus ??
      (billing === "chatgpt" || billing === "grok"
        ? "included"
        : "unavailable"),
    costUsd: totals?.costUsd ?? null,
    inputTokens: totals?.inputTokens ?? null,
    outputTokens: totals?.outputTokens ?? null,
    reasoningTokens: totals?.reasoningTokens ?? null,
    requests: totals?.requests ?? 0,
  };
}

export interface CodeRepositorySnapshot {
  baseBranch: string;
  fullName: string;
  id: string;
}

export interface PublicCodeRepository {
  connectionId: string | null;
  defaultBranch: string;
  enabled: boolean;
  fullName: string;
  id: string;
}

export interface PublicCodeTask {
  agentName: string | null;
  appliedInstructionVersion: number;
  billing: Billing;
  botId: string | null;
  botSlug?: string;
  branch: string | null;
  commitSha: string | null;
  createdAt: string;
  durableSessionId: string | null;
  error: string | null;
  execution: Record<string, unknown>;
  finishedAt: string | null;
  goal: string;
  id: string;
  instructionVersion: number;
  lastStreamCursor: number;
  model: string;
  phase: CodeTaskPhase;
  prUrl: string | null;
  repository: CodeRepositorySnapshot;
  revision: number;
  status: CodeTaskStatus;
  summary: string | null;
  title: string;
  updatedAt: string;
  /** Detail routes always include this; optional keeps older client fixtures compatible. */
  usage?: PublicCodeTaskUsage;
}

export interface PublicCodeEvent {
  createdAt: string;
  data: Record<string, unknown>;
  revision: number;
  seq: number;
  taskId: string;
  type: string;
}

export type PublicCodeTaskSummary = Pick<
  PublicCodeTask,
  | "botSlug"
  | "error"
  | "id"
  | "phase"
  | "prUrl"
  | "repository"
  | "status"
  | "summary"
  | "title"
  | "updatedAt"
>;

export function publicCodeTaskSummary(
  task: PublicCodeTask
): PublicCodeTaskSummary {
  return {
    botSlug: task.botSlug,
    error: task.error,
    id: task.id,
    phase: task.phase,
    prUrl: task.prUrl,
    repository: task.repository,
    status: task.status,
    summary: task.summary,
    title: task.title,
    updatedAt: task.updatedAt,
  };
}

export interface CreateCodeTaskInput {
  ai: CodeTaskAiSnapshot;
  botId: string;
  branch?: string | null;
  goal: string;
  id: string;
  repository: CodeRepositorySnapshot;
  repositoryId: string;
  sourceCallId: string;
  sourceMessageId?: string | null;
  sourceSessionId: string;
  title: string;
}

export interface CodeTaskCommand {
  attempts: number;
  expectedVersion: number;
  id: string;
  instructionVersion: number;
  kind: CodeTaskCommandKind;
  leaseToken: string | null;
  leaseUntil: string | null;
  messageId: string;
  revision: number;
  status: CodeTaskCommandStatus;
  taskId: string;
  text: string | null;
}

export interface CodeTaskCommandInput {
  expectedVersion?: number;
  instructionVersion?: number;
  kind: CodeTaskCommandKind;
  messageId?: string;
  revision?: number;
  text?: string | null;
}

export class CodeTaskNotFoundError extends Error {
  constructor() {
    super("Code task not found.");
    this.name = "CodeTaskNotFoundError";
  }
}

export class CodeTaskConflictError extends Error {
  constructor(message = "The code task changed; retry with the latest state.") {
    super(message);
    this.name = "CodeTaskConflictError";
  }
}

export class CodeTaskAuthorizationError extends Error {
  constructor(message = "You cannot access this code task.") {
    super(message);
    this.name = "CodeTaskAuthorizationError";
  }
}

export function taskEventData(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
