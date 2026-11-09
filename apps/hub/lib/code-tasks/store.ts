import { randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import {
  bots,
  type CodeRepositoryRow,
  type CodeTaskCommandRow,
  type CodeTaskEventRow,
  type CodeTaskRow,
  codeBotContexts,
  codeRepositories,
  codeRepositoryAccess,
  codeTaskBotShutdowns,
  codeTaskCommands,
  codeTaskEvents,
  codeTasks,
  db,
} from "@/lib/db";
import { fxMessageId, generatedFxMessageId } from "./message-id";
import {
  CodeTaskAuthorizationError,
  type CodeTaskCommand,
  type CodeTaskCommandInput,
  CodeTaskConflictError,
  type CodeTaskGenerationCost,
  type CodeTaskGenerationCostInput,
  CodeTaskNotFoundError,
  type CodeTaskPhase,
  type CodeTaskStatus,
  type CodeTaskUsageTotals,
  type CreateCodeTaskInput,
  mergeCodeTaskUsage,
  type PublicCodeEvent,
  type PublicCodeRepository,
  type PublicCodeTask,
  publicCodeTaskUsage,
  taskEventData,
} from "./types";

const LEASE_MS = 5 * 60_000;
const SECRET_KEY =
  /token|secret|password|authorization|credential|apiKey|accessToken|refreshToken/iu;
const REPORTED_USAGE_KEY =
  /^(?:input|output|cacheRead|cacheWrite|reasoning)Tokens$/u;

export interface CodeRepositoryInput {
  connectionId?: string | null;
  defaultBranch: string;
  enabled?: boolean;
  fullName: string;
  githubId: string;
  id?: string;
}

/**
 * Non-state task fields. `status` and `finishedAt` are deliberately absent:
 * every status change goes through `transitionTask`, which keeps the
 * terminal/finishedAt invariant and the source-state CAS in one place.
 */
export interface CodeTaskPatch {
  agentName?: string | null;
  appliedInstructionVersion?: number;
  branch?: string | null;
  commitSha?: string | null;
  durableSessionId?: string | null;
  error?: string | null;
  execution?: Record<string, unknown>;
  lastStreamCursor?: number;
  phase?: CodeTaskPhase;
  pullRequestUrl?: string | null;
  revision?: number;
  summary?: string | null;
}

/** Statuses after which a task holds no execution slot and has `finishedAt`. */
export const TERMINAL_TASK_STATUSES = [
  "ready",
  "failed",
  "needs_attention",
  "cancelled",
] as const satisfies readonly CodeTaskStatus[];

export function isTerminalTaskStatus(status: CodeTaskStatus): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

/**
 * Execution keys owned by dedicated runtime writers (heartbeat, fencing,
 * cancellation, notification outbox, cleanup). A whole-object execution patch
 * built from an older read can never overwrite or remove them.
 */
export const RUNTIME_EXECUTION_KEYS = [
  "usage",
  "modelRequests",
  "runtimeHeartbeatAt",
  "observedAt",
  "executionGeneration",
  "recovery",
  "lastRecovery",
  "cancelRequestedAt",
  "cancelDispatching",
  "cancelProbeId",
  "cancelCommandId",
  "notification",
  "notificationInstructionVersion",
  "notificationMessageId",
  "notificationSkipped",
  "followEndedAt",
  "workspaceExpiredAt",
  "workspaceDeletedAt",
] as const;

/** The fencing generation of the task's current runtime. Legacy rows are generation 0. */
export function executionGeneration(value: unknown): number {
  const generation = executionRecord(value).executionGeneration;
  return typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation > 0
    ? generation
    : 0;
}

/** A recovery that fenced the runtime and has not been resolved yet. */
export function activeRecovery(value: unknown): Record<string, unknown> | null {
  const { recovery } = executionRecord(value);
  if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
    return null;
  }
  const record = recovery as Record<string, unknown>;
  return record.resolvedAt ? null : record;
}

function withoutRuntimeKeys(
  value: Record<string, unknown>
): Record<string, unknown> {
  const output = { ...value };
  for (const key of RUNTIME_EXECUTION_KEYS) {
    delete output[key];
  }
  return output;
}

/** SQL jsonb with only the runtime-owned keys currently stored on the row. */
function currentRuntimeExecution(): SQL {
  const parts = RUNTIME_EXECUTION_KEYS.map((key) =>
    key === "usage"
      ? sql`jsonb_build_object('usage', coalesce(${codeTasks.execution}->'usage', '{}'::jsonb))`
      : sql`(case when ${codeTasks.execution} ? ${key}::text then jsonb_build_object(${key}::text, ${codeTasks.execution}->${key}::text) else '{}'::jsonb end)`
  );
  return sql.join(parts, sql` || `);
}

const activeRecoverySql = sql`(${codeTasks.execution}->'recovery' is not null and ${codeTasks.execution}->'recovery'->'resolvedAt' is null)`;
const generationSql = sql`coalesce((${codeTasks.execution}->>'executionGeneration')::integer, 0)`;
export interface CodeTaskLease {
  command: CodeTaskCommandRow;
  leaseToken: string;
  task: CodeTaskRow;
}

function iso(value: Date | null | undefined): string | null {
  return value?.toISOString() ?? null;
}

function safeExecution(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const redact = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(redact);
    }
    if (!input || typeof input !== "object") {
      return input;
    }
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (REPORTED_USAGE_KEY.test(key)) {
        if (
          typeof child !== "number" ||
          !Number.isSafeInteger(child) ||
          child < 0
        ) {
          continue;
        }
      } else if (SECRET_KEY.test(key)) {
        continue;
      }
      output[key] = redact(child);
    }
    return output;
  };
  return redact(value) as Record<string, unknown>;
}

function executionRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function usageRecord(value: unknown): Record<string, unknown> | null {
  const execution = executionRecord(value);
  const { usage } = execution;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }
  return usage as Record<string, unknown>;
}

function workspaceWasDeleted(value: unknown): boolean {
  const execution = executionRecord(value);
  return [execution.workspaceDeletedAt, execution.workspaceExpiredAt].some(
    (marker) => marker !== undefined && marker !== null
  );
}

export function publicRepository(row: CodeRepositoryRow): PublicCodeRepository {
  return {
    connectionId: row.connectionId,
    defaultBranch: row.defaultBranch,
    enabled: row.enabled,
    fullName: row.fullName,
    id: row.id,
  };
}

export function publicTask(
  row: CodeTaskRow,
  botSlug?: string | null
): PublicCodeTask {
  return {
    botId: row.botId,
    id: row.id,
    ...(botSlug ? { botSlug } : {}),
    agentName: row.agentName,
    appliedInstructionVersion: row.appliedInstructionVersion,
    billing: row.billing,
    branch: row.branch,
    commitSha: row.commitSha,
    createdAt: row.createdAt.toISOString(),
    durableSessionId: row.durableSessionId,
    error: row.error,
    execution: safeExecution(row.execution),
    finishedAt: iso(row.finishedAt),
    goal: row.goal,
    instructionVersion: row.instructionVersion,
    lastStreamCursor: row.lastStreamCursor,
    model: row.model,
    phase: row.phase,
    prUrl: row.pullRequestUrl,
    repository: {
      baseBranch: row.baseBranch,
      fullName: row.repositoryFullName,
      id: row.repositorySnapshotId,
    },
    revision: row.revision,
    status: row.status,
    summary: row.summary,
    title: row.title,
    updatedAt: row.updatedAt.toISOString(),
    usage: publicCodeTaskUsage(
      usageRecord(row.execution) as Partial<CodeTaskUsageTotals> | null,
      row.billing
    ),
  };
}

export function publicCommand(row: CodeTaskCommandRow): CodeTaskCommand {
  return {
    attempts: row.attempts,
    expectedVersion: row.expectedVersion,
    id: row.id,
    instructionVersion: row.instructionVersion,
    kind: row.kind,
    leaseToken: row.leaseToken,
    leaseUntil: iso(row.leaseUntil),
    messageId: row.messageId,
    revision: row.revision,
    status: row.status,
    taskId: row.taskId,
    text: row.text,
  };
}

export function publicEvent(row: CodeTaskEventRow): PublicCodeEvent {
  return {
    createdAt: row.createdAt.toISOString(),
    data: taskEventData(row.data),
    revision: row.revision,
    seq: row.seq,
    taskId: row.taskId,
    type: row.type,
  };
}

export async function getTaskRow(id: string): Promise<CodeTaskRow | undefined> {
  const [row] = await db()
    .select()
    .from(codeTasks)
    .where(eq(codeTasks.id, id))
    .limit(1);
  return row;
}

export async function getTaskBySession(
  sessionId: string
): Promise<CodeTaskRow | undefined> {
  const [row] = await db()
    .select()
    .from(codeTasks)
    .where(eq(codeTasks.durableSessionId, sessionId))
    .limit(1);
  return row;
}

export async function getPublicTask(
  id: string
): Promise<PublicCodeTask | null> {
  const [row] = await db()
    .select({ botSlug: bots.slug, task: codeTasks })
    .from(codeTasks)
    .leftJoin(bots, eq(codeTasks.botId, bots.id))
    .where(eq(codeTasks.id, id))
    .limit(1);
  return row ? publicTask(row.task, row.botSlug) : null;
}

export async function listTasks(
  options: { botId?: string; limit?: number } = {}
): Promise<PublicCodeTask[]> {
  const where = options.botId ? eq(codeTasks.botId, options.botId) : undefined;
  const rows = await db()
    .select({ botSlug: bots.slug, task: codeTasks })
    .from(codeTasks)
    .leftJoin(bots, eq(codeTasks.botId, bots.id))
    .where(where)
    .orderBy(desc(codeTasks.createdAt), desc(codeTasks.id))
    .limit(options.limit ?? 50);
  return rows.map((row) => publicTask(row.task, row.botSlug));
}

export async function getRepositoryRow(
  id: string
): Promise<CodeRepositoryRow | undefined> {
  const [row] = await db()
    .select()
    .from(codeRepositories)
    .where(eq(codeRepositories.id, id))
    .limit(1);
  return row;
}

export async function listRepositories(): Promise<PublicCodeRepository[]> {
  // Repository connections are shared across the single-account app.
  const rows = await db()
    .select({ repo: codeRepositories })
    .from(codeRepositories)
    .where(eq(codeRepositories.enabled, true))
    .orderBy(asc(codeRepositories.fullName));
  return rows.map((row) => publicRepository(row.repo));
}

export async function putRepository(
  input: CodeRepositoryInput
): Promise<PublicCodeRepository> {
  const [row] = await db()
    .insert(codeRepositories)
    .values({
      ...(input.id ? { id: input.id } : {}),
      connectionId: input.connectionId ?? null,
      defaultBranch: input.defaultBranch,
      enabled: input.enabled ?? true,
      fullName: input.fullName,
      githubId: input.githubId,
    })
    .onConflictDoUpdate({
      set: {
        connectionId: input.connectionId ?? null,
        defaultBranch: input.defaultBranch,
        fullName: input.fullName,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        updatedAt: new Date(),
      },
      target: codeRepositories.githubId,
    })
    .returning();
  if (!row) {
    throw new Error("Could not save repository.");
  }
  return publicRepository(row);
}

export function setActiveRepository(
  botId: string,
  repositoryId: string
): Promise<PublicCodeRepository> {
  return db().transaction(async (tx) => {
    const [repo] = await tx
      .select()
      .from(codeRepositories)
      .where(
        and(
          eq(codeRepositories.id, repositoryId),
          eq(codeRepositories.enabled, true)
        )
      )
      .limit(1);
    if (!repo) {
      throw new CodeTaskNotFoundError();
    }
    const [bot] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.id, botId))
      .limit(1);
    if (!bot) {
      throw new CodeTaskAuthorizationError("Bot not found.");
    }
    await tx
      .insert(codeRepositoryAccess)
      .values({ botId, repositoryId })
      .onConflictDoNothing();
    await tx
      .insert(codeBotContexts)
      .values({ botId, repositoryId, updatedAt: new Date() })
      .onConflictDoUpdate({
        set: { repositoryId, updatedAt: new Date() },
        target: codeBotContexts.botId,
      });
    return publicRepository(repo);
  });
}

export const setActiveRepo = setActiveRepository;

export async function getActiveRepository(
  botId: string
): Promise<PublicCodeRepository | null> {
  const [row] = await db()
    .select({ repo: codeRepositories })
    .from(codeBotContexts)
    .innerJoin(
      codeRepositories,
      eq(codeRepositories.id, codeBotContexts.repositoryId)
    )
    .where(
      and(eq(codeBotContexts.botId, botId), eq(codeRepositories.enabled, true))
    )
    .limit(1);
  return row ? publicRepository(row.repo) : null;
}

export const getActiveRepo = getActiveRepository;

export async function createTask(
  input: CreateCodeTaskInput
): Promise<PublicCodeTask> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: transactional idempotency and outbox invariants are intentionally kept together.
  const row = await db().transaction(async (tx) => {
    // KEY SHARE conflicts only with the FOR UPDATE that a bot shutdown takes,
    // so a task cannot be admitted concurrently with the start of a deletion.
    const [bot] = await tx
      .select({ id: bots.id })
      .from(bots)
      .where(eq(bots.id, input.botId))
      .for("key share");
    if (!bot) {
      throw new CodeTaskAuthorizationError("Bot not found.");
    }
    const [shutdown] = await tx
      .select({ botId: codeTaskBotShutdowns.botId })
      .from(codeTaskBotShutdowns)
      .where(eq(codeTaskBotShutdowns.botId, input.botId))
      .limit(1);
    if (shutdown) {
      throw new CodeTaskAuthorizationError("This bot is being deleted.");
    }
    const [repository] = await tx
      .select()
      .from(codeRepositories)
      .where(
        and(
          eq(codeRepositories.id, input.repositoryId),
          eq(codeRepositories.enabled, true)
        )
      )
      .limit(1);
    if (!repository) {
      throw new CodeTaskNotFoundError();
    }
    // Preserve provenance for the active-context selector; this is not an
    // authorization grant because app-level connections are shared.
    await tx
      .insert(codeRepositoryAccess)
      .values({ botId: input.botId, repositoryId: input.repositoryId })
      .onConflictDoNothing();
    const [existing] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, input.id))
      .limit(1);
    if (existing) {
      if (
        existing.botId !== input.botId ||
        existing.sourceSessionId !== input.sourceSessionId ||
        existing.sourceCallId !== input.sourceCallId ||
        existing.goal !== input.goal
      ) {
        throw new CodeTaskConflictError(
          "This task id already belongs to different work."
        );
      }
      return existing;
    }
    const [sameOrigin] = await tx
      .select()
      .from(codeTasks)
      .where(
        and(
          eq(codeTasks.botId, input.botId),
          eq(codeTasks.sourceSessionId, input.sourceSessionId),
          eq(codeTasks.sourceCallId, input.sourceCallId)
        )
      )
      .limit(1);
    if (sameOrigin) {
      return sameOrigin;
    }
    const [created] = await tx
      .insert(codeTasks)
      .values({
        agentName: input.ai.agentName ?? null,
        baseBranch: input.repository.baseBranch,
        billing: input.ai.billing,
        botId: input.botId,
        branch: input.branch ?? null,
        fast: input.ai.fast,
        goal: input.goal,
        id: input.id,
        model: input.ai.model,
        phase: "preparing",
        repositoryFullName: input.repository.fullName,
        repositoryId: input.repositoryId,
        repositorySnapshotId: input.repository.id,
        sourceCallId: input.sourceCallId,
        sourceMessageId: input.sourceMessageId ?? null,
        sourceSessionId: input.sourceSessionId,
        status: "queued",
        title: input.title,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      const [raced] = await tx
        .select()
        .from(codeTasks)
        .where(eq(codeTasks.id, input.id))
        .limit(1);
      if (
        raced &&
        raced.botId === input.botId &&
        raced.sourceSessionId === input.sourceSessionId &&
        raced.sourceCallId === input.sourceCallId &&
        raced.goal === input.goal
      ) {
        return raced;
      }
      throw new CodeTaskConflictError(
        "This task id already belongs to different work."
      );
    }
    await tx.insert(codeTaskCommands).values({
      expectedVersion: created.version,
      id: input.id,
      instructionVersion: created.instructionVersion,
      kind: "start",
      messageId: generatedFxMessageId(created.id, "start"),
      revision: created.revision,
      status: "queued",
      taskId: created.id,
      text: input.goal,
    });
    await tx.insert(codeTaskEvents).values({
      data: { repository: created.repositoryFullName, title: created.title },
      revision: created.revision,
      seq: 1,
      sourceKey: `task.created:${created.id}`,
      taskId: created.id,
      type: "task.created",
    });
    return created;
  });
  return publicTask(row);
}

export async function enqueueCommand(
  taskId: string,
  input: CodeTaskCommandInput
): Promise<CodeTaskCommand> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: command sequencing, deduplication and task CAS must be atomic.
  const row = await db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const messageId = fxMessageId(
      input.messageId ?? generatedFxMessageId(taskId, String(task.version + 1))
    );
    const [existing] = await tx
      .select()
      .from(codeTaskCommands)
      .where(
        and(
          eq(codeTaskCommands.taskId, taskId),
          eq(codeTaskCommands.messageId, messageId)
        )
      )
      .limit(1);
    if (existing) {
      if (
        existing.kind !== input.kind ||
        existing.text !== (input.text ?? null)
      ) {
        throw new CodeTaskConflictError(
          "Command id already belongs to different input."
        );
      }
      return existing;
    }
    if (input.kind === "steer" && workspaceWasDeleted(task.execution)) {
      throw new CodeTaskConflictError(
        "This task's workspace is no longer available; start a new task."
      );
    }
    if (["cancelled", "failed"].includes(task.status)) {
      throw new CodeTaskConflictError(
        "This task is no longer accepting commands."
      );
    }
    if (task.status === "cancel_requested" && input.kind !== "cancel") {
      throw new CodeTaskConflictError("This task is being cancelled.");
    }
    // A task whose bot was deleted keeps its history but accepts no new work.
    // Cancellation stays possible: it can only stop remaining execution.
    if (!task.botId && input.kind !== "cancel") {
      throw new CodeTaskConflictError(
        "This task's bot was deleted; it no longer accepts instructions."
      );
    }
    if (task.botId && input.kind !== "cancel") {
      const [shutdown] = await tx
        .select({ botId: codeTaskBotShutdowns.botId })
        .from(codeTaskBotShutdowns)
        .where(eq(codeTaskBotShutdowns.botId, task.botId))
        .limit(1);
      if (shutdown) {
        throw new CodeTaskConflictError(
          "This task's bot is being deleted; it no longer accepts instructions."
        );
      }
    }
    if (
      input.kind === "steer" &&
      !isTerminalTaskStatus(task.status) &&
      activeRecovery(task.execution)
    ) {
      throw new CodeTaskConflictError(
        "This task is recovering; wait for it to stop before sending corrections."
      );
    }
    if (task.leaseToken && task.leaseUntil && task.leaseUntil > new Date()) {
      throw new CodeTaskConflictError(
        "This task is publishing; wait for that operation to finish."
      );
    }
    const expectedVersion = input.expectedVersion ?? task.version;
    if (expectedVersion !== task.version) {
      throw new CodeTaskConflictError();
    }
    const instructionVersion =
      input.kind === "steer"
        ? task.instructionVersion + 1
        : task.instructionVersion;
    const revision =
      input.kind === "steer" && task.status === "ready"
        ? task.revision + 1
        : task.revision;
    const wakingTask =
      input.kind === "steer" &&
      ["waiting_for_input", "ready", "needs_attention"].includes(task.status);
    const current = executionRecord(task.execution);
    let nextExecution: Record<string, unknown> | undefined;
    if (wakingTask) {
      // An explicit correction starts a new run. A resolved recovery stays as
      // history, while its generation fence keeps rejecting the old runtime.
      const { recovery, ...rest } = current;
      nextExecution = {
        ...rest,
        ...(recovery ? { lastRecovery: recovery } : {}),
        executionReserved: false,
        startedAt: Date.now(),
      };
    } else if (input.kind === "cancel" && task.status !== "cancel_requested") {
      nextExecution = { ...current, cancelRequestedAt: Date.now() };
    }
    const [command] = await tx
      .insert(codeTaskCommands)
      .values({
        expectedVersion,
        instructionVersion,
        kind: input.kind,
        messageId,
        revision,
        status: "queued",
        taskId,
        text: input.text ?? null,
      })
      .returning();
    if (!command) {
      throw new CodeTaskConflictError("Could not enqueue command.");
    }
    await tx
      .update(codeTasks)
      .set({
        version: task.version + 1,
        ...(input.kind === "steer"
          ? {
              error: null,
              instructionVersion,
              revision,
              ...(wakingTask
                ? {
                    execution: nextExecution,
                    finishedAt: null,
                    phase: "recovering" as const,
                    status: "queued" as const,
                  }
                : { status: "running" as const }),
            }
          : {}),
        // cancel_requested is an active state: it never carries a finish time.
        ...(input.kind === "cancel"
          ? {
              ...(nextExecution ? { execution: nextExecution } : {}),
              finishedAt: null,
              status: "cancel_requested" as const,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(eq(codeTasks.id, taskId), eq(codeTasks.version, task.version))
      );
    return command;
  });
  return publicCommand(row);
}

const activeExecutionWhere = and(
  sql`${codeTasks.status} not in ('waiting_for_input', 'ready', 'needs_attention', 'cancelled', 'failed')`,
  or(
    and(
      eq(codeTasks.status, "running"),
      sql`${codeTasks.durableSessionId} is not null`
    ),
    sql`coalesce(${codeTasks.execution}->>'executionReserved', 'false') = 'true'`
  )
);

/**
 * Atomically reserve one execution slot for a task.
 *
 * Every repository row is locked in id order before counting active tasks. This
 * intentionally serializes the small global budget without relying on advisory
 * locks, which keeps the invariant portable to the hosted Postgres and local
 * PGlite implementations.
 */
export function reserveExecution(taskId: string): Promise<CodeTaskRow | null> {
  return db().transaction(async (tx) => {
    await tx
      .select({ id: codeRepositories.id })
      .from(codeRepositories)
      .orderBy(asc(codeRepositories.id))
      .for("update");

    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    if (
      ["cancel_requested", "cancelled", "failed"].includes(task.status) ||
      workspaceWasDeleted(task.execution)
    ) {
      return null;
    }

    const active = await tx
      .select({
        id: codeTasks.id,
        repositoryFullName: codeTasks.repositoryFullName,
        repositoryId: codeTasks.repositoryId,
      })
      .from(codeTasks)
      .where(activeExecutionWhere);
    const others = active.filter((candidate) => candidate.id !== task.id);
    if (
      others.length >= 2 ||
      others.some(
        (candidate) =>
          (candidate.repositoryId !== null &&
            task.repositoryId !== null &&
            candidate.repositoryId === task.repositoryId) ||
          candidate.repositoryFullName.toLowerCase() ===
            task.repositoryFullName.toLowerCase()
      )
    ) {
      return null;
    }

    const [reserved] = await tx
      .update(codeTasks)
      .set({
        execution: {
          ...executionRecord(task.execution),
          executionReserved: true,
        },
        phase: "preparing",
        status: "running",
        updatedAt: new Date(),
        version: task.version + 1,
      })
      .where(
        and(eq(codeTasks.id, task.id), eq(codeTasks.version, task.version))
      )
      .returning();
    return reserved ?? null;
  });
}

export function claimCommands(
  now = new Date(),
  limit = 20
): Promise<CodeTaskLease[]> {
  return db().transaction(async (tx) => {
    const candidates = await tx
      .select()
      .from(codeTasks)
      .innerJoin(codeTaskCommands, eq(codeTaskCommands.taskId, codeTasks.id))
      .where(
        and(
          or(
            eq(codeTaskCommands.status, "queued"),
            and(
              eq(codeTaskCommands.status, "leased"),
              lte(codeTaskCommands.leaseUntil, now)
            )
          ),
          or(
            isNull(codeTaskCommands.leaseUntil),
            lte(codeTaskCommands.leaseUntil, now)
          )
        )
      )
      .orderBy(asc(codeTaskCommands.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true });
    const leases: CodeTaskLease[] = [];
    for (const candidate of candidates) {
      const command = candidate.code_task_commands;
      // biome-ignore lint/performance/noAwaitInLoops: command ordering requires serial claims.
      const [firstPending] = await tx
        .select({ id: codeTaskCommands.id })
        .from(codeTaskCommands)
        .where(
          and(
            eq(codeTaskCommands.taskId, command.taskId),
            or(
              eq(codeTaskCommands.status, "queued"),
              eq(codeTaskCommands.status, "leased")
            )
          )
        )
        .orderBy(
          asc(codeTaskCommands.expectedVersion),
          asc(codeTaskCommands.createdAt),
          asc(codeTaskCommands.id)
        )
        .limit(1);
      if (firstPending?.id !== command.id) {
        continue;
      }
      const messageId = fxMessageId(command.messageId);
      const leaseToken = randomUUID();
      const [updated] = await tx
        .update(codeTaskCommands)
        .set({
          attempts: command.attempts + 1,
          leaseToken,
          leaseUntil: new Date(now.getTime() + LEASE_MS),
          messageId,
          status: "leased",
        })
        .where(
          and(
            eq(codeTaskCommands.id, command.id),
            or(
              eq(codeTaskCommands.status, "queued"),
              eq(codeTaskCommands.status, "leased")
            )
          )
        )
        .returning();
      if (updated) {
        leases.push({
          command: updated,
          leaseToken,
          task: candidate.code_tasks,
        });
      }
    }
    return leases;
  });
}

export function associateSession(
  taskId: string,
  sessionId: string,
  agentName?: string | null,
  expectedVersion?: number
): Promise<PublicCodeTask> {
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    if (task.durableSessionId && task.durableSessionId !== sessionId) {
      throw new CodeTaskConflictError(
        "Task already has a different durable session."
      );
    }
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new CodeTaskConflictError();
    }
    if (task.durableSessionId === sessionId) {
      return publicTask(task);
    }
    const [row] = await tx
      .update(codeTasks)
      .set({
        durableSessionId: sessionId,
        ...(agentName === undefined ? {} : { agentName }),
        status: "running",
        updatedAt: new Date(),
        version: task.version + 1,
      })
      .where(and(eq(codeTasks.id, taskId), isNull(codeTasks.durableSessionId)))
      .returning();
    if (!row) {
      throw new CodeTaskConflictError(
        "Task session was already associated or task no longer exists."
      );
    }
    return publicTask(row);
  });
}

export async function recordCommandAccepted(
  commandId: string,
  leaseToken: string,
  messageId: string
): Promise<CodeTaskCommand> {
  const [row] = await db()
    .update(codeTaskCommands)
    .set({ leaseToken: null, leaseUntil: null, messageId, status: "accepted" })
    .where(
      and(
        eq(codeTaskCommands.id, commandId),
        eq(codeTaskCommands.leaseToken, leaseToken),
        eq(codeTaskCommands.status, "leased")
      )
    )
    .returning();
  if (row) {
    return publicCommand(row);
  }
  const [alreadyAccepted] = await db()
    .select()
    .from(codeTaskCommands)
    .where(
      and(
        eq(codeTaskCommands.id, commandId),
        eq(codeTaskCommands.messageId, messageId)
      )
    )
    .limit(1);
  if (
    alreadyAccepted &&
    ["accepted", "applied", "settled"].includes(alreadyAccepted.status)
  ) {
    return publicCommand(alreadyAccepted);
  }
  throw new CodeTaskConflictError("Command lease is stale.");
}

function appliedCommandUpdate(lateForTerminal: boolean) {
  const now = new Date();
  return lateForTerminal
    ? {
        appliedAt: now,
        finishedAt: now,
        leaseToken: null,
        leaseUntil: null,
        status: "settled" as const,
      }
    : {
        appliedAt: now,
        leaseToken: null,
        leaseUntil: null,
        status: "applied" as const,
      };
}

const LATE_APPLY_STATUSES: readonly CodeTaskStatus[] = [
  "cancelled",
  "failed",
  "needs_attention",
];

export async function markInstructionApplied(
  taskId: string,
  commandId: string,
  expectedVersion?: number
): Promise<PublicCodeTask> {
  const row = await db().transaction(async (tx) => {
    const [command] = await tx
      .select()
      .from(codeTaskCommands)
      .where(
        and(
          eq(codeTaskCommands.id, commandId),
          eq(codeTaskCommands.taskId, taskId)
        )
      )
      .limit(1);
    if (!command) {
      throw new CodeTaskNotFoundError();
    }
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    if (
      command.instructionVersion <= task.appliedInstructionVersion ||
      ["applied", "settled"].includes(command.status)
    ) {
      return task;
    }
    if (expectedVersion !== undefined && task.version !== expectedVersion) {
      throw new CodeTaskConflictError();
    }
    // A projected turn_start/user_message is evidence that the agent saw the
    // instruction, never a request for new work. Only queued/running tasks
    // move to running; a terminal task keeps its status, slot release and
    // finishedAt. Reviving a task is reserved for enqueueCommand's steer.
    const lateForTerminal = LATE_APPLY_STATUSES.includes(task.status);
    const nextStatus: CodeTaskStatus =
      task.status === "queued" || task.status === "running"
        ? "running"
        : task.status;
    const [updated] = await tx
      .update(codeTasks)
      .set({
        appliedInstructionVersion: Math.max(
          task.appliedInstructionVersion,
          command.instructionVersion
        ),
        status: nextStatus,
        ...(nextStatus === "running" ? { finishedAt: null } : {}),
        updatedAt: new Date(),
        version: task.version + 1,
      })
      .where(
        and(
          eq(codeTasks.id, taskId),
          eq(codeTasks.version, task.version),
          eq(codeTasks.status, task.status)
        )
      )
      .returning();
    if (!updated) {
      // Unreachable under the row lock; a stale line is never forced through.
      return task;
    }
    // The agent applied the instruction after the task ended: settle the
    // command so neither the projector nor workspace cleanup waits for a
    // turn_end that belongs to no live execution.
    await tx
      .update(codeTaskCommands)
      .set(appliedCommandUpdate(lateForTerminal))
      .where(
        and(
          eq(codeTaskCommands.id, commandId),
          inArray(codeTaskCommands.status, ["queued", "leased", "accepted"])
        )
      );
    await tx
      .insert(codeTaskEvents)
      .values({
        data: {
          commandId,
          instructionVersion: command.instructionVersion,
          ...(lateForTerminal ? { afterTaskEnded: task.status } : {}),
        },
        revision: updated.revision,
        seq: sql`coalesce((select max(seq) + 1 from code_task_events where task_id = ${taskId}), 1)`,
        sourceKey: `command.applied:${commandId}`,
        taskId,
        type: "command.applied",
      })
      .onConflictDoNothing();
    return updated;
  });
  return publicTask(row);
}

/**
 * Who may settle a command:
 * - `{ leaseToken }`: the dispatcher holding that exact lease of a `leased`
 *   command. A stale token (another worker re-leased it) matches nothing.
 * - `"unsettled"`: an internal reconciliation that owns the command through
 *   the task state; it settles any command not yet `settled`/`failed`.
 * There is no nullable token: absence never silently drops the lease check.
 */
export type CommandSettleLease = { leaseToken: string } | "unsettled";

export async function recordCommandSettled(
  commandId: string,
  lease: CommandSettleLease,
  error: string | null = null
): Promise<CodeTaskCommand> {
  const [row] = await db()
    .update(codeTaskCommands)
    .set({
      error,
      finishedAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
      status: error ? "failed" : "settled",
    })
    .where(
      and(
        eq(codeTaskCommands.id, commandId),
        ...(lease === "unsettled"
          ? [
              inArray(codeTaskCommands.status, [
                "queued",
                "leased",
                "accepted",
                "applied",
              ]),
            ]
          : [
              eq(codeTaskCommands.leaseToken, lease.leaseToken),
              eq(codeTaskCommands.status, "leased"),
            ])
      )
    )
    .returning();
  if (!row) {
    throw new CodeTaskConflictError(
      "Command no longer exists or lease is stale."
    );
  }
  return publicCommand(row);
}

export async function updateTask(
  taskId: string,
  patch: CodeTaskPatch,
  options: {
    expectedVersion?: number;
    sessionId?: string;
    leaseToken?: string;
  } = {}
): Promise<PublicCodeTask> {
  const where = [
    eq(codeTasks.id, taskId),
    ...(options.expectedVersion === undefined
      ? []
      : [eq(codeTasks.version, options.expectedVersion)]),
    ...(options.sessionId === undefined
      ? []
      : [eq(codeTasks.durableSessionId, options.sessionId)]),
    ...(options.leaseToken === undefined
      ? []
      : [eq(codeTasks.leaseToken, options.leaseToken)]),
  ];
  // Runtime-owned keys always come from the current row, so a patch built
  // from an older read cannot drop a fence, cancellation or outbox marker.
  const executionPatch = patch.execution
    ? sql`(${JSON.stringify(withoutRuntimeKeys(patch.execution))}::jsonb || ${currentRuntimeExecution()})`
    : undefined;
  const [row] = await db()
    .update(codeTasks)
    .set({
      ...patch,
      ...(executionPatch ? { execution: executionPatch } : {}),
      updatedAt: new Date(),
      version: sql`${codeTasks.version} + 1`,
    })
    .where(and(...where))
    .returning();
  if (!row) {
    throw new CodeTaskConflictError("Task update lost its lease or version.");
  }
  return publicTask(row);
}

export interface TaskTransition {
  /** Ordinary execution fields; runtime-owned keys are ignored here. */
  execution?: Record<string, unknown>;
  expectedVersion?: number;
  /** Source statuses that justify the write. */
  from: readonly CodeTaskStatus[];
  /** Require this runtime fencing generation. */
  generation?: number;
  /** Require this publication lease. */
  leaseToken?: string;
  patch?: Omit<CodeTaskPatch, "execution">;
  /** Runtime-owned execution fields written by the server state machine. */
  runtime?: Record<string, unknown>;
  sessionId?: string;
  /** Target status. Omit to change only guarded fields. */
  to?: CodeTaskStatus;
  /** Require that no unresolved recovery fences the runtime. */
  unfenced?: boolean;
  /** Extra decision predicate, such as a matching cancellation order. */
  where?: SQL;
}

/**
 * The single writer of task status. The UPDATE validates the source state,
 * and optionally version/session/lease/generation, and returns null on any
 * conflict: callers re-read or abandon, they never overwrite.
 *
 * Invariant (N-03): terminal status ⇔ finishedAt is set. Entering a terminal
 * status stamps finishedAt and clears the execution reservation; entering an
 * active status clears finishedAt.
 */
export async function transitionTask(
  taskId: string,
  transition: TaskTransition
): Promise<CodeTaskRow | null> {
  const now = new Date();
  const terminal =
    transition.to !== undefined && isTerminalTaskStatus(transition.to);
  const merged = {
    ...withoutRuntimeKeys(transition.execution ?? {}),
    ...(transition.runtime ?? {}),
    ...(terminal ? { executionReserved: false } : {}),
  };
  const where = [
    eq(codeTasks.id, taskId),
    inArray(codeTasks.status, [...transition.from]),
    ...(transition.expectedVersion === undefined
      ? []
      : [eq(codeTasks.version, transition.expectedVersion)]),
    ...(transition.sessionId === undefined
      ? []
      : [eq(codeTasks.durableSessionId, transition.sessionId)]),
    ...(transition.leaseToken === undefined
      ? []
      : [eq(codeTasks.leaseToken, transition.leaseToken)]),
    ...(transition.generation === undefined
      ? []
      : [sql`${generationSql} = ${transition.generation}`]),
    ...(transition.unfenced ? [sql`not ${activeRecoverySql}`] : []),
    ...(transition.where ? [transition.where] : []),
  ];
  const [row] = await db()
    .update(codeTasks)
    .set({
      ...transition.patch,
      ...(transition.to === undefined
        ? {}
        : {
            finishedAt: terminal ? now : null,
            status: transition.to,
            ...(terminal && transition.patch?.phase === undefined
              ? { phase: null }
              : {}),
          }),
      ...(Object.keys(merged).length
        ? {
            execution: sql`${codeTasks.execution} || ${JSON.stringify(merged)}::jsonb`,
          }
        : {}),
      updatedAt: now,
      version: sql`${codeTasks.version} + 1`,
    })
    .where(and(...where))
    .returning();
  return row ?? null;
}

/**
 * Merge runtime-owned execution fields without a version bump (they record
 * runtime facts, not user-visible state). Returns null when the guard fails.
 */
export async function patchRuntimeExecution(
  taskId: string,
  fields: Record<string, unknown>,
  guard: { statuses?: readonly CodeTaskStatus[]; where?: SQL } = {}
): Promise<CodeTaskRow | null> {
  const [row] = await db()
    .update(codeTasks)
    .set({
      execution: sql`${codeTasks.execution} || ${JSON.stringify(fields)}::jsonb`,
    })
    .where(
      and(
        eq(codeTasks.id, taskId),
        ...(guard.statuses
          ? [inArray(codeTasks.status, [...guard.statuses])]
          : []),
        ...(guard.where ? [guard.where] : [])
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Broker admission for a host tool call. The heartbeat write is the fence
 * check: it succeeds only for a running, unfenced task whose generation is
 * the caller's turn generation. A watchdog that fenced the task first makes
 * this return null; one that observed the old heartbeat loses its own CAS.
 */
export async function admitToolCall(
  taskId: string,
  sessionId: string,
  generation: number,
  now = Date.now()
): Promise<CodeTaskRow | null> {
  return await patchRuntimeExecution(
    taskId,
    { runtimeHeartbeatAt: now },
    {
      statuses: ["running"],
      where: and(
        eq(codeTasks.durableSessionId, sessionId),
        sql`${generationSql} = ${generation}`,
        sql`not ${activeRecoverySql}`,
        sql`not (${codeTasks.execution} ? 'workspaceExpiredAt')`,
        sql`not (${codeTasks.execution} ? 'workspaceDeletedAt')`
      ),
    }
  );
}

/** Statuses whose runtime may still obtain model credentials. */
export const MODEL_ADMISSIBLE_STATUSES = [
  "queued",
  "running",
  "waiting_for_input",
  "ready",
] as const satisfies readonly CodeTaskStatus[];

/** Whether a model/subscription credential may be handed to this task's runtime. */
export function modelCredentialsAllowed(task: CodeTaskRow): boolean {
  const execution = executionRecord(task.execution);
  return (
    (MODEL_ADMISSIBLE_STATUSES as readonly string[]).includes(task.status) &&
    !activeRecovery(execution) &&
    !workspaceWasDeleted(execution)
  );
}

/**
 * Broker admission for one model request: counts it and renews the runtime
 * heartbeat atomically with the fence check.
 */
export async function admitModelRequest(
  taskId: string,
  sessionId: string,
  now = Date.now()
): Promise<CodeTaskRow | null> {
  const [row] = await db()
    .update(codeTasks)
    .set({
      execution: sql`jsonb_set(${codeTasks.execution}, '{modelRequests}', to_jsonb(coalesce((${codeTasks.execution}->>'modelRequests')::integer, 0) + 1)) || jsonb_build_object('runtimeHeartbeatAt', ${now}::bigint)`,
    })
    .where(
      and(
        eq(codeTasks.id, taskId),
        eq(codeTasks.durableSessionId, sessionId),
        inArray(codeTasks.status, [...MODEL_ADMISSIBLE_STATUSES]),
        sql`not ${activeRecoverySql}`,
        sql`not (${codeTasks.execution} ? 'workspaceExpiredAt')`,
        sql`not (${codeTasks.execution} ? 'workspaceDeletedAt')`
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Settle accepted/applied commands of a terminal task. They can no longer
 * receive a turn_end from a live execution, so they would otherwise keep the
 * workspace from ever being cleaned up. Each reconciliation is recorded.
 */
export function reconcileOrphanCommands(
  taskId: string,
  reason: string
): Promise<number> {
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!(task && isTerminalTaskStatus(task.status))) {
      return 0;
    }
    const settled = await tx
      .update(codeTaskCommands)
      .set({
        error: reason,
        finishedAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        status: "settled",
      })
      .where(
        and(
          eq(codeTaskCommands.taskId, taskId),
          or(
            inArray(codeTaskCommands.status, ["accepted", "applied"]),
            and(
              eq(codeTaskCommands.kind, "cancel"),
              inArray(codeTaskCommands.status, ["queued", "leased"])
            )
          )
        )
      )
      .returning({ id: codeTaskCommands.id });
    if (settled.length) {
      await tx
        .insert(codeTaskEvents)
        .values(
          settled.map((command, index) => ({
            data: { commandId: command.id, reason },
            revision: task.revision,
            seq: sql`coalesce((select max(seq) from code_task_events where task_id = ${taskId}), 0) + ${index + 1}`,
            sourceKey: `command.reconciled:${command.id}`,
            taskId,
            type: "command.reconciled",
          }))
        )
        .onConflictDoNothing();
    }
    return settled.length;
  });
}

export function appendEvent(
  taskId: string,
  type: string,
  data: unknown,
  options: {
    sourceKey: string;
    revision?: number;
    afterStreamCursor?: number;
    throughStreamCursor?: number;
  }
): Promise<PublicCodeEvent> {
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const [existing] = await tx
      .select()
      .from(codeTaskEvents)
      .where(
        and(
          eq(codeTaskEvents.taskId, taskId),
          eq(codeTaskEvents.sourceKey, options.sourceKey)
        )
      )
      .limit(1);
    if (existing) {
      if (options.throughStreamCursor !== undefined) {
        await tx
          .update(codeTasks)
          .set({
            lastStreamCursor: sql`greatest(${codeTasks.lastStreamCursor}, ${options.throughStreamCursor})`,
          })
          .where(eq(codeTasks.id, taskId));
      }
      return publicEvent(existing);
    }
    if (
      options.afterStreamCursor !== undefined &&
      task.lastStreamCursor !== options.afterStreamCursor
    ) {
      throw new CodeTaskConflictError(
        "The task stream advanced; retry projection from the latest cursor."
      );
    }
    const [last] = await tx
      .select({ seq: codeTaskEvents.seq })
      .from(codeTaskEvents)
      .where(eq(codeTaskEvents.taskId, taskId))
      .orderBy(desc(codeTaskEvents.seq))
      .limit(1);
    const [row] = await tx
      .insert(codeTaskEvents)
      .values({
        data: taskEventData(data),
        revision: options.revision ?? task.revision,
        seq: (last?.seq ?? 0) + 1,
        sourceKey: options.sourceKey,
        taskId,
        type,
      })
      .returning();
    if (!row) {
      throw new CodeTaskConflictError("Could not append task event.");
    }
    if (options.throughStreamCursor !== undefined) {
      await tx
        .update(codeTasks)
        .set({
          lastStreamCursor: sql`greatest(${codeTasks.lastStreamCursor}, ${options.throughStreamCursor})`,
        })
        .where(eq(codeTasks.id, taskId));
    }
    return publicEvent(row);
  });
}

const USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
const GENERATION_ID_PATTERN = /^gen_[A-Za-z0-9]+$/u;

function nonNegativeCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function reportedUsage(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const source = value as Record<string, unknown>;
  return Object.fromEntries(
    USAGE_FIELDS.flatMap((field) => {
      const count = source[field];
      return typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count >= 0
        ? [[field, count]]
        : [];
    })
  );
}

/**
 * Persist one libfx turn's provider-reported usage exactly once. The usage
 * event and the aggregate task snapshot share a transaction so a projector
 * retry cannot double count a turn or leave the two views out of sync.
 */
export function recordTurnUsage(
  taskId: string,
  cursor: number,
  usage: unknown
): Promise<ReturnType<typeof publicCodeTaskUsage>> | null {
  const reported = reportedUsage(usage);
  if (!Object.keys(reported).length) {
    return null;
  }
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const sourceKey = `usage:${cursor}`;
    const [existing] = await tx
      .select()
      .from(codeTaskEvents)
      .where(
        and(
          eq(codeTaskEvents.taskId, taskId),
          eq(codeTaskEvents.sourceKey, sourceKey)
        )
      )
      .limit(1);
    const current = usageRecord(task.execution);
    if (existing) {
      return publicCodeTaskUsage(
        current as Partial<CodeTaskUsageTotals> | null,
        task.billing
      );
    }
    const next = mergeCodeTaskUsage(
      current as Partial<CodeTaskUsageTotals> | null,
      reported
    );
    const [last] = await tx
      .select({ seq: codeTaskEvents.seq })
      .from(codeTaskEvents)
      .where(eq(codeTaskEvents.taskId, taskId))
      .orderBy(desc(codeTaskEvents.seq))
      .limit(1);
    await tx.insert(codeTaskEvents).values({
      data: taskEventData({ ...reported, requests: 1 }),
      revision: task.revision,
      seq: (last?.seq ?? 0) + 1,
      sourceKey,
      taskId,
      type: "usage.recorded",
    });
    await tx
      .update(codeTasks)
      .set({
        execution: { ...executionRecord(task.execution), usage: next },
        updatedAt: new Date(),
        version: sql`${codeTasks.version} + 1`,
      })
      .where(eq(codeTasks.id, taskId));
    return publicCodeTaskUsage(next, task.billing);
  });
}

function generationIdsFrom(value: Record<string, unknown> | null): string[] {
  const ids = value?.generationIds;
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids.filter(
    (id): id is string =>
      typeof id === "string" && GENERATION_ID_PATTERN.test(id)
  );
}

function generationCostsFrom(
  value: Record<string, unknown> | null
): Record<string, CodeTaskGenerationCost> {
  const raw = value?.generationCosts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const output: Record<string, CodeTaskGenerationCost> = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (
      !(GENERATION_ID_PATTERN.test(id) && entry) ||
      typeof entry !== "object" ||
      Array.isArray(entry)
    ) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const { totalCost } = record;
    if (
      typeof totalCost !== "number" ||
      !Number.isFinite(totalCost) ||
      totalCost < 0
    ) {
      continue;
    }
    const optionalCost = (key: string): number | null =>
      nonNegativeCost(record[key]);
    output[id] = {
      gatewayCost: optionalCost("gatewayCost"),
      marketCost: optionalCost("marketCost"),
      surchargeCost: optionalCost("surchargeCost"),
      totalCost,
    };
  }
  return output;
}

/** Associate a streamed AI Gateway generation with a task exactly once. */
export function recordGenerationId(
  taskId: string,
  generationId: string
): Promise<ReturnType<typeof publicCodeTaskUsage>> | null {
  if (!GENERATION_ID_PATTERN.test(generationId)) {
    return null;
  }
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const current = usageRecord(task.execution);
    const ids = generationIdsFrom(current);
    const sourceKey = `generation:${generationId}`;
    const [existing] = await tx
      .select()
      .from(codeTaskEvents)
      .where(
        and(
          eq(codeTaskEvents.taskId, taskId),
          eq(codeTaskEvents.sourceKey, sourceKey)
        )
      )
      .limit(1);
    if (existing || ids.includes(generationId)) {
      return publicCodeTaskUsage(
        current as Partial<CodeTaskUsageTotals> | null,
        task.billing
      );
    }
    const next = mergeCodeTaskUsage(
      current as Partial<CodeTaskUsageTotals> | null,
      null
    );
    next.generationIds = [...ids, generationId];
    next.costStatus = "pending";
    const [last] = await tx
      .select({ seq: codeTaskEvents.seq })
      .from(codeTaskEvents)
      .where(eq(codeTaskEvents.taskId, taskId))
      .orderBy(desc(codeTaskEvents.seq))
      .limit(1);
    await tx.insert(codeTaskEvents).values({
      data: { generationId },
      revision: task.revision,
      seq: (last?.seq ?? 0) + 1,
      sourceKey,
      taskId,
      type: "usage.generation_recorded",
    });
    await tx
      .update(codeTasks)
      .set({
        execution: { ...executionRecord(task.execution), usage: next },
        updatedAt: new Date(),
        version: sql`${codeTasks.version} + 1`,
      })
      .where(eq(codeTasks.id, taskId));
    return publicCodeTaskUsage(next, task.billing);
  });
}

/** Persist one authoritative AI Gateway cost and aggregate it by generation ID. */
export function recordGenerationCost(
  taskId: string,
  input: CodeTaskGenerationCostInput
): Promise<ReturnType<typeof publicCodeTaskUsage>> | null {
  if (
    !(
      GENERATION_ID_PATTERN.test(input.generationId) &&
      Number.isFinite(input.totalCost)
    ) ||
    input.totalCost < 0
  ) {
    return null;
  }
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const current = usageRecord(task.execution);
    const ids = generationIdsFrom(current);
    if (!ids.includes(input.generationId)) {
      return publicCodeTaskUsage(
        current as Partial<CodeTaskUsageTotals> | null,
        task.billing
      );
    }
    const sourceKey = `cost:${input.generationId}`;
    const [existingEvent] = await tx
      .select()
      .from(codeTaskEvents)
      .where(
        and(
          eq(codeTaskEvents.taskId, taskId),
          eq(codeTaskEvents.sourceKey, sourceKey)
        )
      )
      .limit(1);
    if (existingEvent) {
      return publicCodeTaskUsage(
        current as Partial<CodeTaskUsageTotals> | null,
        task.billing
      );
    }
    const costs = generationCostsFrom(current);
    costs[input.generationId] = {
      gatewayCost: nonNegativeCost(input.gatewayCost),
      marketCost: nonNegativeCost(input.marketCost),
      surchargeCost: nonNegativeCost(input.surchargeCost),
      totalCost: input.totalCost,
    };
    const next = mergeCodeTaskUsage(
      current as Partial<CodeTaskUsageTotals> | null,
      null
    );
    next.generationIds = ids;
    next.generationCosts = costs;
    next.costUsd = Object.values(costs).reduce(
      (total, cost) => total + cost.totalCost,
      0
    );
    const resolved = ids.filter((id) => costs[id]).length;
    next.costStatus = resolved === ids.length ? "reported" : "partial";
    const [last] = await tx
      .select({ seq: codeTaskEvents.seq })
      .from(codeTaskEvents)
      .where(eq(codeTaskEvents.taskId, taskId))
      .orderBy(desc(codeTaskEvents.seq))
      .limit(1);
    await tx.insert(codeTaskEvents).values({
      data: {
        gatewayCost: nonNegativeCost(input.gatewayCost),
        generationId: input.generationId,
        marketCost: nonNegativeCost(input.marketCost),
        surchargeCost: nonNegativeCost(input.surchargeCost),
        totalCost: input.totalCost,
      },
      revision: task.revision,
      seq: (last?.seq ?? 0) + 1,
      sourceKey,
      taskId,
      type: "usage.cost_recorded",
    });
    await tx
      .update(codeTasks)
      .set({
        execution: { ...executionRecord(task.execution), usage: next },
        updatedAt: new Date(),
        version: sql`${codeTasks.version} + 1`,
      })
      .where(eq(codeTasks.id, taskId));
    return publicCodeTaskUsage(next, task.billing);
  });
}

/** Mark an unresolved generation lookup as unavailable while preserving known costs. */
export function markGenerationCostUnavailable(
  taskId: string
): Promise<ReturnType<typeof publicCodeTaskUsage>> | null {
  return db().transaction(async (tx) => {
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(eq(codeTasks.id, taskId))
      .for("update");
    if (!task) {
      throw new CodeTaskNotFoundError();
    }
    const current = usageRecord(task.execution);
    const costs = generationCostsFrom(current);
    const nextStatus = Object.keys(costs).length ? "partial" : "unavailable";
    if (
      current?.costStatus === "reported" ||
      current?.costStatus === nextStatus
    ) {
      return publicCodeTaskUsage(
        current as Partial<CodeTaskUsageTotals> | null,
        task.billing
      );
    }
    const next = mergeCodeTaskUsage(
      current as Partial<CodeTaskUsageTotals> | null,
      null
    );
    next.costStatus = nextStatus;
    if (Object.keys(costs).length) {
      next.generationCosts = costs;
      next.costUsd = Object.values(costs).reduce(
        (total, cost) => total + cost.totalCost,
        0
      );
    }
    await tx
      .update(codeTasks)
      .set({
        execution: { ...executionRecord(task.execution), usage: next },
        updatedAt: new Date(),
        version: sql`${codeTasks.version} + 1`,
      })
      .where(eq(codeTasks.id, taskId));
    return publicCodeTaskUsage(next, task.billing);
  });
}

export async function listEvents(
  taskId: string,
  after = 0,
  limit = 200
): Promise<PublicCodeEvent[]> {
  const rows = await db()
    .select()
    .from(codeTaskEvents)
    .where(
      and(eq(codeTaskEvents.taskId, taskId), gt(codeTaskEvents.seq, after))
    )
    .orderBy(asc(codeTaskEvents.seq))
    .limit(limit);
  return rows.map(publicEvent);
}

export async function assertPublication(
  taskId: string,
  revision: number,
  instructionVersion: number
): Promise<CodeTaskRow> {
  const [task] = await db()
    .select()
    .from(codeTasks)
    .where(
      and(
        eq(codeTasks.id, taskId),
        eq(codeTasks.revision, revision),
        eq(codeTasks.instructionVersion, instructionVersion),
        eq(codeTasks.appliedInstructionVersion, instructionVersion),
        eq(codeTasks.status, "running")
      )
    )
    .limit(1);
  if (!task) {
    throw new CodeTaskConflictError(
      "Publication is stale or newer instructions are pending."
    );
  }
  const [pending] = await db()
    .select({ id: codeTaskCommands.id })
    .from(codeTaskCommands)
    .where(
      and(
        eq(codeTaskCommands.taskId, taskId),
        eq(codeTaskCommands.status, "queued"),
        gt(codeTaskCommands.instructionVersion, instructionVersion)
      )
    )
    .limit(1);
  if (pending) {
    throw new CodeTaskConflictError("A newer task instruction is pending.");
  }
  return task;
}

/**
 * Hold the task's publication lease while an external GitHub operation runs.
 * Steers and cancellation commands check this lease before they are queued, so
 * a late instruction cannot race a branch/PR write that was already admitted.
 */
export async function withPublicationLease<T>(
  taskId: string,
  revision: number,
  instructionVersion: number,
  run: (task: CodeTaskRow, leaseToken: string) => Promise<T>,
  generation = 0
): Promise<T> {
  const leaseToken = randomUUID();
  const locked = await db().transaction(async (tx) => {
    // Publication is a broker point: a fenced or older-generation runtime
    // can never obtain the lease that guards GitHub writes.
    const [task] = await tx
      .select()
      .from(codeTasks)
      .where(
        and(
          eq(codeTasks.id, taskId),
          eq(codeTasks.revision, revision),
          eq(codeTasks.instructionVersion, instructionVersion),
          eq(codeTasks.appliedInstructionVersion, instructionVersion),
          eq(codeTasks.status, "running"),
          sql`${generationSql} = ${generation}`,
          sql`not ${activeRecoverySql}`
        )
      )
      .for("update");
    if (!task) {
      throw new CodeTaskConflictError(
        "Publication is stale or newer instructions are pending."
      );
    }
    const [pending] = await tx
      .select({ id: codeTaskCommands.id })
      .from(codeTaskCommands)
      .where(
        and(
          eq(codeTaskCommands.taskId, taskId),
          or(
            eq(codeTaskCommands.status, "queued"),
            eq(codeTaskCommands.status, "leased"),
            eq(codeTaskCommands.status, "accepted")
          ),
          gt(codeTaskCommands.instructionVersion, instructionVersion)
        )
      )
      .limit(1);
    if (pending) {
      throw new CodeTaskConflictError("A newer task instruction is pending.");
    }
    const [lockedRow] = await tx
      .update(codeTasks)
      .set({
        leaseToken,
        leaseUntil: new Date(Date.now() + LEASE_MS),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codeTasks.id, taskId),
          or(
            isNull(codeTasks.leaseToken),
            lte(codeTasks.leaseUntil, new Date())
          )
        )
      )
      .returning();
    if (!lockedRow) {
      throw new CodeTaskConflictError(
        "Task publication is already in progress."
      );
    }
    return lockedRow;
  });
  try {
    return await run(locked, leaseToken);
  } finally {
    await db()
      .update(codeTasks)
      .set({ leaseToken: null, leaseUntil: null, updatedAt: new Date() })
      .where(
        and(eq(codeTasks.id, taskId), eq(codeTasks.leaseToken, leaseToken))
      );
  }
}
