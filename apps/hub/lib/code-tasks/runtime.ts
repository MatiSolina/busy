import { getVercelOidcToken } from "@vercel/oidc";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { getWorld, sandbox, waitUntil } from "durable-harness";
import { fxTools } from "durable-harness/fx";
import {
  createFxAgent,
  type FxAgent,
  type FxAgentHostTool,
  type FxAgentOptions,
  type FxStreamLine,
} from "libfx";
import { world } from "libfx/durable-world";
import { getSubscriptionAccess } from "../ai/subscription-store";
import type { Billing } from "../bots/models";
import { type CodeTaskRow, codeTaskCommands, codeTasks, db } from "../db";
import {
  codeInstructions,
  codingTools,
  safeCodeOutput,
  type TaskExecution,
} from "./agent-tools";
import { notifyCodeResult } from "./notify";
import {
  accessTokenOnly,
  type CodeTaskProfile,
  codeTaskModel,
  createFxTransport,
  lookupGatewayGeneration,
  providerOptions,
} from "./providers";
import {
  activeRecovery,
  admitModelRequest,
  appendEvent,
  associateSession,
  type CodeTaskLease,
  claimCommands,
  executionGeneration,
  getTaskBySession,
  getTaskRow,
  isTerminalTaskStatus,
  markGenerationCostUnavailable,
  markInstructionApplied,
  modelCredentialsAllowed,
  patchRuntimeExecution,
  reconcileOrphanCommands,
  recordCommandAccepted,
  recordCommandSettled,
  recordGenerationCost,
  recordGenerationId,
  recordTurnUsage,
  reserveExecution,
  transitionTask,
  updateTask,
} from "./store";
import { codeStreamLines } from "./stream";

const FX_MESSAGE_ID_ERROR_PATTERN = /messageId/u;

function dispatchFailureCategory(
  error: unknown
): "invalid_message_id" | "unknown" {
  return error instanceof TypeError &&
    FX_MESSAGE_ID_ERROR_PATTERN.test(error.message)
    ? "invalid_message_id"
    : "unknown";
}

const BILLINGS: Billing[] = ["gateway", "token-pass", "chatgpt", "grok"];
const MAX_MODEL_REQUESTS = 120;
const REPOSITORY_RUNTIME_MS = 45 * 60_000;
const TASK_GENERATION_ID_PATTERN = /^gen_[A-Za-z0-9]+$/u;
type Agents = Record<Billing, FxAgent>;
let initializing: Promise<Agents> | undefined;

/**
 * Credential broker for model requests (the transport's `lookupTask`). A
 * fenced, cancelled or terminal task gets no credentials. The execution
 * limit only denies further requests and, if the task is still running,
 * marks it needs_attention by CAS; it never overwrites a cancellation.
 */
export async function profileFor(
  sessionId: string
): Promise<CodeTaskProfile | null> {
  const task = await getTaskBySession(sessionId);
  if (!(task && modelCredentialsAllowed(task))) {
    return null;
  }
  const state = task.execution as TaskExecution;
  if (
    Date.now() - (state.startedAt ?? task.createdAt.getTime()) >
      REPOSITORY_RUNTIME_MS ||
    (state.modelRequests ?? 0) >= MAX_MODEL_REQUESTS
  ) {
    await transitionTask(task.id, {
      expectedVersion: task.version,
      from: ["queued", "running"],
      patch: { error: "The code task reached its execution limit." },
      to: "needs_attention",
    });
    return null;
  }
  const admitted = await admitModelRequest(task.id, sessionId);
  if (!admitted) {
    return null;
  }
  return {
    billing: task.billing,
    fast: task.fast,
    model: task.model,
    sessionId,
    taskId: task.id,
  };
}

const generationLookupAt = new Map<string, number>();

/** Refresh a bounded set of pending Gateway generations without delaying task work. */
export async function refreshCodeTaskCosts(taskId: string): Promise<void> {
  const task = await getTaskRow(taskId);
  if (!task || (task.billing !== "gateway" && task.billing !== "token-pass")) {
    return;
  }
  const lastLookup = generationLookupAt.get(taskId) ?? 0;
  if (Date.now() - lastLookup < 5000) {
    return;
  }
  const execution: Record<string, unknown> =
    task.execution && typeof task.execution === "object" ? task.execution : {};
  const usage =
    execution.usage &&
    typeof execution.usage === "object" &&
    !Array.isArray(execution.usage)
      ? (execution.usage as Record<string, unknown>)
      : null;
  const ids = Array.isArray(usage?.generationIds)
    ? usage.generationIds.filter(
        (id): id is string =>
          typeof id === "string" && TASK_GENERATION_ID_PATTERN.test(id)
      )
    : [];
  const costs =
    usage?.generationCosts &&
    typeof usage.generationCosts === "object" &&
    !Array.isArray(usage.generationCosts)
      ? usage.generationCosts
      : {};
  const pending = ids.filter((id) => !Object.hasOwn(costs, id)).slice(0, 3);
  if (!pending.length) {
    return;
  }
  generationLookupAt.set(taskId, Date.now());
  const profile: CodeTaskProfile = {
    billing: task.billing,
    fast: task.fast,
    model: task.model,
    sessionId: task.durableSessionId ?? `cost-${task.id}`,
    taskId: task.id,
  };
  await Promise.allSettled(
    pending.map(async (generationId) => {
      const result = await lookupGatewayGeneration(profile, generationId, {
        fetch: globalThis.fetch.bind(globalThis),
        getGatewayCredential: () => getVercelOidcToken(),
        getTokenPassCredential: () => {
          const key = process.env.TOKEN_PASS_API_KEY;
          if (!key) {
            throw new Error("Token Pass is unavailable.");
          }
          return Promise.resolve(key);
        },
      });
      if (result.status === "ready") {
        const persisted = recordGenerationCost(task.id, result.info);
        if (persisted) {
          await persisted;
        }
      } else if (result.status === "unavailable") {
        const marked = markGenerationCostUnavailable(task.id);
        if (marked) {
          await marked;
        }
      }
    })
  );
}

/** Named profiles are process configuration. Session settings carry the saved per-task model. */
export function codeAgents(): Promise<Agents> {
  initializing ??= (async () => {
    const shared = await getWorld();
    const durability = world(() => shared, {
      leaseMs: 15_000,
      maxDurationMs: 240_000,
      name: "busy-code",
      queueDurable: true,
      runInRequest: false,
      store: "busy-code",
      waitUntil,
    });
    const workspace = sandbox({
      budget: { vmSeconds: 2700 },
      commandTimeoutMs: 120_000,
      idleMs: 60_000,
      vcpus: 2,
    });
    const base = fxTools(workspace, { world: shared }) as FxAgentHostTool[];
    const tools = codingTools(base, projectTask);
    const transport = createFxTransport({
      getGatewayCredential: () => getVercelOidcToken(),
      getGatewayModelCatalog: async () => {
        const response = await fetch(
          "https://ai-gateway.vercel.sh/coding-agent/v1/models",
          { signal: AbortSignal.timeout(15_000) }
        );
        if (!response.ok) {
          throw new Error("The Gateway model catalog is unavailable.");
        }
        return response.json();
      },
      getSubscriptionAccess,
      getTokenPassCredential: () => {
        const key = process.env.TOKEN_PASS_API_KEY;
        if (!key) {
          throw new Error(
            "Token Pass is unavailable; billing fallback is disabled."
          );
        }
        return Promise.resolve(key);
      },
      lookupTask: profileFor,
      onGenerationId: async (profile, generationId) => {
        const persisted = recordGenerationId(profile.taskId, generationId);
        if (persisted) {
          await persisted;
        }
      },
    });
    const entries = BILLINGS.map((billing) => {
      const profile = providerOptions(billing);
      const common = {
        durability,
        fetch: transport,
        instructions: codeInstructions,
        name: profile.agentName,
        tools,
      };
      let options: FxAgentOptions;
      if (profile.provider === "gateway") {
        // Only the trusted transport supplies real credentials, on every request.
        options = {
          ...common,
          apiKey: "busy-transport-owned",
          provider: "gateway",
        };
      } else {
        const credentials = async ({ sessionId }: { sessionId?: string }) => {
          const task = sessionId ? await getTaskBySession(sessionId) : null;
          if (
            !task ||
            task.billing !== billing ||
            !(billing === "chatgpt" || billing === "grok") ||
            !modelCredentialsAllowed(task)
          ) {
            throw new Error("The AI connection does not belong to this task.");
          }
          const access = await getSubscriptionAccess(billing);
          return accessTokenOnly(access.credentials);
        };
        options =
          profile.provider === "codex"
            ? { ...common, credentials, provider: "codex" }
            : { ...common, credentials, provider: "grok" };
      }
      return [billing, createFxAgent(options)] as const;
    });
    return Object.fromEntries(entries) as Agents;
  })().catch((error) => {
    initializing = undefined;
    throw error;
  });
  return initializing;
}

/**
 * Session settings. `context` reaches every host tool of a turn started by
 * this prompt/steer (FxToolContext.context), so its executionGeneration is
 * what the broker compares to fence a runtime that was recovered.
 */
export function settings(task: CodeTaskRow) {
  return {
    context: {
      executionGeneration: executionGeneration(task.execution),
      instructionVersion: task.instructionVersion,
      revision: task.revision,
      taskId: task.id,
    },
    model: codeTaskModel(task),
  };
}

async function deferCommand(lease: CodeTaskLease) {
  await db()
    .update(codeTaskCommands)
    .set({ leaseToken: null, leaseUntil: null, status: "queued" })
    .where(
      and(
        eq(codeTaskCommands.id, lease.command.id),
        eq(codeTaskCommands.leaseToken, lease.leaseToken),
        eq(codeTaskCommands.status, "leased")
      )
    );
}

async function dispatchCancel(
  task: CodeTaskRow,
  agent: FxAgent,
  lease: CodeTaskLease
) {
  const { command, leaseToken } = lease;
  if (!task.durableSessionId) {
    // Nothing ever ran: the stop is trivially confirmed.
    await confirmCancellation(task.id, {
      commandId: null,
      sourceKey: `cancelled:${command.id}`,
    });
    await recordCommandSettled(command.id, { leaseToken });
    return;
  }
  // Bind the in-flight cancellation to this order before touching the
  // session; a task resolved by another cause is not cancelled again.
  const marked = await patchRuntimeExecution(
    task.id,
    { cancelCommandId: command.id, cancelDispatching: true },
    { statuses: ["cancel_requested"] }
  );
  if (!marked) {
    await recordCommandSettled(command.id, { leaseToken });
    return;
  }
  const session = agent.session(task.durableSessionId, settings(task));
  await session.cancel();
  // An idle cancellation has no turn_end. This queued read/continue probe confirms
  // cancellation without adding a new prompt; only its own idle event is accepted.
  const accepted = await session.resume().accepted;
  await patchRuntimeExecution(
    task.id,
    {
      cancelCommandId: command.id,
      cancelDispatching: false,
      cancelProbeId: accepted.messageId,
    },
    {
      statuses: ["cancel_requested"],
      where: sql`${codeTasks.execution}->>'cancelCommandId' = ${command.id}`,
    }
  );
  await recordCommandAccepted(command.id, leaseToken, command.messageId);
  await projectTask(task.id);
}

async function dispatch(lease: CodeTaskLease) {
  const { command, leaseToken } = lease;
  let task = await getTaskRow(lease.task.id);
  if (!task) {
    return;
  }
  let stage:
    | "agent_init"
    | "load"
    | "prompt"
    | "record_accept"
    | "reserve"
    | "session_open"
    | "await_accept" = "load";
  try {
    if (
      task.execution.workspaceExpiredAt ||
      task.execution.workspaceDeletedAt ||
      task.status === "cancelled" ||
      task.status === "failed" ||
      (task.status === "cancel_requested" && command.kind !== "cancel")
    ) {
      await recordCommandSettled(command.id, { leaseToken });
      return;
    }
    if (command.kind !== "cancel") {
      stage = "reserve";
      const reserved = await reserveExecution(task.id);
      if (!reserved) {
        await deferCommand(lease);
        return;
      }
      task = reserved;
    }
    stage = "agent_init";
    const agents = await codeAgents();
    const agent = agents[task.billing];
    if (command.kind === "cancel") {
      await dispatchCancel(task, agent, lease);
      return;
    }
    stage = "session_open";
    if (!task.durableSessionId) {
      const sessionId = await agent.newSessionId();
      await associateSession(task.id, sessionId, agent.name, task.version);
      const associated = await getTaskRow(task.id);
      if (!associated) {
        throw new Error("Code task not found.");
      }
      task = associated;
      await updateTask(task.id, {
        execution: { ...task.execution, startedAt: Date.now() },
      });
    }
    // Save the command's original settings, not newer instructions which may be queued behind it.
    const inputTask = {
      ...task,
      instructionVersion: command.instructionVersion,
      revision: command.revision,
    };
    const sessionId = task.durableSessionId;
    if (!sessionId) {
      throw new Error("The code task has no session.");
    }
    const session = agent.session(sessionId, settings(inputTask));
    if (command.kind === "start") {
      stage = "prompt";
      const text = `Repository: ${task.repositoryFullName}\nBase branch: ${task.baseBranch}\nOwned branch: ${task.branch}\n\nTask: ${task.title}\n\n${task.goal}\n\nBegin with prepare_repository. Deliver a draft PR through the controlled tools.`;
      const turn = session.prompt(text, { messageId: command.messageId });
      stage = "await_accept";
      await turn.accepted;
    } else {
      stage = "prompt";
      await session.steer(command.text ?? "", {
        messageId: command.messageId,
      });
    }
    stage = "record_accept";
    await recordCommandAccepted(command.id, leaseToken, command.messageId);
    await appendEvent(
      task.id,
      "command.accepted",
      { instructionVersion: command.instructionVersion, kind: command.kind },
      { sourceKey: `accepted:${command.id}` }
    );
  } catch (error) {
    console.error("code-task.dispatch_failed", {
      category: dispatchFailureCategory(error),
      commandId: command.id,
      stage,
      taskId: task.id,
    });
    if (command.attempts < 3) {
      await deferCommand(lease);
      return;
    }
    await recordCommandSettled(
      command.id,
      { leaseToken },
      "The agent could not accept this command. Check the AI connection and retry."
    ).catch(() => undefined);
    if (command.kind === "cancel") {
      // A failed cancel dispatch never resolves the task: it stays
      // cancel_requested (fenced) and the watchdog stops it explicitly.
      await patchRuntimeExecution(
        task.id,
        { cancelDispatching: false },
        { statuses: ["cancel_requested"] }
      );
      return;
    }
    // Only a task still queued/running can be parked; a concurrent
    // cancellation or result is never overwritten.
    await transitionTask(task.id, {
      from: ["queued", "running"],
      patch: {
        error:
          "The agent could not accept this command. Check the AI connection and task setup.",
      },
      to: "needs_attention",
    });
  }
}

export async function dispatchCodeCommands() {
  const leases = await claimCommands(new Date(), 20);
  // Commands for the same task stay ordered; the store admits only the earliest unsent command.
  for (const lease of leases) {
    // biome-ignore lint/performance/noAwaitInLoops: dispatch order also enforces the application concurrency budget.
    await dispatch(lease);
  }
  return leases.length;
}

async function applied(task: CodeTaskRow, messageId: string | undefined) {
  if (!messageId) {
    return;
  }
  const [command] = await db()
    .select()
    .from(codeTaskCommands)
    .where(
      and(
        eq(codeTaskCommands.taskId, task.id),
        eq(codeTaskCommands.messageId, messageId)
      )
    )
    .limit(1);
  if (command && command.kind !== "cancel") {
    await markInstructionApplied(task.id, command.id);
  }
}

function projectedToolInput(
  line: Extract<FxStreamLine, { type: "tool_start" }>
): string | null {
  let input: unknown = line.input;
  if (input === undefined && line.inputTruncated) {
    input = line.inputPreview;
  }
  if (input === undefined) {
    return null;
  }
  if (typeof input === "string") {
    return safeCodeOutput(input);
  }
  const serialized = JSON.stringify(input);
  return safeCodeOutput(serialized.slice(0, 4000));
}

function projectedToolName(name: string): string {
  return name.trim() || "tool";
}

/** Pure projection: reasoning is excluded and every persisted source identity is deterministic. */
export function projectFxEvent(
  line: FxStreamLine
): { type: string; data: Record<string, unknown> } | null {
  if (line.type === "tool_start") {
    return {
      data: {
        callId: line.id,
        command: projectedToolInput(line),
        name: projectedToolName(line.name),
      },
      type: "tool.start",
    };
  }
  if (line.type === "tool_end") {
    return {
      data: {
        callId: line.id,
        isError: Boolean(line.isError),
        name: projectedToolName(line.name),
        output: line.content ? safeCodeOutput(line.content) : null,
      },
      type: "tool.end",
    };
  }
  if (line.type === "text_delta") {
    const message = safeCodeOutput(line.delta);
    return message ? { data: { message }, type: "agent.message" } : null;
  }
  if (line.type === "user_message") {
    return {
      data: { message: safeCodeOutput(line.text) },
      type: "instruction.applied",
    };
  }
  if (line.type === "turn_start" || line.type === "turn_resume") {
    return {
      data: {
        message:
          line.type === "turn_resume"
            ? "Resuming the saved task"
            : "Working on the task",
        messageId: line.messageId,
        resumed: line.type === "turn_resume",
      },
      type: "agent.working",
    };
  }
  if (line.type === "turn_end") {
    return {
      data: { messageId: line.messageId, stopReason: line.stopReason },
      type: "agent.turn_ended",
    };
  }
  return null;
}

type TerminalTask = Pick<
  CodeTaskRow,
  "appliedInstructionVersion" | "instructionVersion" | "status"
>;

export function terminalAttentionMessage(
  line: Extract<FxStreamLine, { type: "turn_end" }>,
  task: TerminalTask,
  hasPendingCommand: boolean
): string | null {
  if (task.status !== "running" || hasPendingCommand) {
    return null;
  }
  if (line.stopReason === "error") {
    return "The coding agent could not finish. Check its AI connection and task activity.";
  }
  if (task.instructionVersion === task.appliedInstructionVersion) {
    return "The agent stopped before recording a verified result. Send a correction to continue.";
  }
  return null;
}

export async function settleTurnBeforePending(
  settle: () => Promise<void>,
  readPending: () => Promise<boolean>
): Promise<boolean> {
  await settle();
  return readPending();
}

const projecting = new Map<string, Promise<void>>();

/** Tail only a bounded read of the saved stream. Dropping this reader never cancels the agent. */
export function projectTask(id: string): Promise<void> {
  const existing = projecting.get(id);
  if (existing) {
    return existing;
  }
  const work = projectTaskOnce(id).finally(() => projecting.delete(id));
  projecting.set(id, work);
  return work;
}

async function projectTaskOnce(id: string) {
  const task = await getTaskRow(id);
  if (!task?.durableSessionId) {
    return;
  }
  const agents = await codeAgents();
  const reader = agents[task.billing]
    .session(task.durableSessionId, settings(task))
    .stream(task.lastStreamCursor)
    .getReader();
  const timer = setTimeout(() => {
    reader.cancel().catch(() => undefined);
  }, 1000);
  let cursor = task.lastStreamCursor;
  try {
    for await (const line of codeStreamLines(reader)) {
      if (typeof line.cursor !== "number" || line.cursor <= cursor) {
        continue;
      }
      if (line.type === "text_delta") {
        // Narration and its final covered cursor commit together: retries cannot
        // append a differently sized batch of the same already-recorded tokens.
        await appendEvent(
          id,
          "agent.message",
          { message: safeCodeOutput(line.delta), messageId: line.messageId },
          {
            afterStreamCursor: cursor,
            sourceKey: `fx:text:${line.cursor}`,
            throughStreamCursor: line.cursor,
          }
        );
      } else {
        await ingest(task, line);
        await db()
          .update(codeTasks)
          .set({
            lastStreamCursor: sql`greatest(${codeTasks.lastStreamCursor}, ${line.cursor})`,
          })
          .where(eq(codeTasks.id, id));
      }
      ({ cursor } = line);
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    // Observation only: reading the stream proves nothing about the runtime.
    await patchRuntimeExecution(id, { observedAt: Date.now() }).catch(
      () => null
    );
  }
}

/**
 * Resolve cancel_requested → cancelled once the stop of a specific order is
 * confirmed. A late or foreign confirmation for a task that another cause
 * already resolved changes nothing.
 */
async function confirmCancellation(
  taskId: string,
  confirmation: { commandId: string | null; sourceKey: string }
): Promise<boolean> {
  const cancelled = await transitionTask(taskId, {
    from: ["cancel_requested"],
    runtime: { cancelDispatching: false },
    to: "cancelled",
    ...(confirmation.commandId
      ? {
          where: sql`${codeTasks.execution}->>'cancelCommandId' = ${confirmation.commandId}`,
        }
      : {}),
  });
  if (!cancelled) {
    return false;
  }
  await db()
    .update(codeTaskCommands)
    .set({
      finishedAt: new Date(),
      leaseToken: null,
      leaseUntil: null,
      status: "settled",
    })
    .where(
      and(
        eq(codeTaskCommands.taskId, taskId),
        eq(codeTaskCommands.kind, "cancel"),
        inArray(codeTaskCommands.status, [
          "queued",
          "leased",
          "accepted",
          "applied",
        ])
      )
    );
  await appendEvent(
    taskId,
    "task.cancelled",
    {},
    { sourceKey: confirmation.sourceKey }
  );
  return true;
}

function cancelCommandOf(task: CodeTaskRow): string | null {
  const id = task.execution.cancelCommandId;
  return typeof id === "string" ? id : null;
}

async function settleTurnCommand(
  taskId: string,
  messageId: string | undefined,
  appliedInstructionVersion: number
) {
  if (messageId) {
    await db()
      .update(codeTaskCommands)
      .set({ finishedAt: new Date(), status: "settled" })
      .where(
        and(
          eq(codeTaskCommands.taskId, taskId),
          eq(codeTaskCommands.messageId, messageId),
          inArray(codeTaskCommands.status, ["accepted", "applied"])
        )
      );
  }
  await db()
    .update(codeTaskCommands)
    .set({ finishedAt: new Date(), status: "settled" })
    .where(
      and(
        eq(codeTaskCommands.taskId, taskId),
        eq(codeTaskCommands.status, "applied"),
        lte(codeTaskCommands.instructionVersion, appliedInstructionVersion)
      )
    );
}

async function ingestIdle(
  origin: CodeTaskRow,
  line: Extract<FxStreamLine, { type: "idle" }>
) {
  const latest = await getTaskRow(origin.id);
  // Another projector may read the idle ACK before dispatch has persisted its
  // request id. Keep the cursor before that fact so the next read can match it.
  if (
    latest?.status === "cancel_requested" &&
    latest.execution.cancelDispatching
  ) {
    throw new Error("Cancellation confirmation is still being recorded.");
  }
  if (
    latest?.status === "cancel_requested" &&
    latest.execution.cancelProbeId === line.requestId
  ) {
    // Legacy rows dispatched before order binding have no command id.
    await confirmCancellation(latest.id, {
      commandId: cancelCommandOf(latest),
      sourceKey: `cancelled:${line.cursor}`,
    });
    return;
  }
  const recovery = latest ? activeRecovery(latest.execution) : null;
  if (
    latest &&
    recovery &&
    (recovery.probeId === line.requestId ||
      probeIdsOf(recovery).includes(line.requestId))
  ) {
    // The watchdog's own stop probe came back idle: the stop is confirmed.
    await patchRuntimeExecution(
      latest.id,
      { recovery: { ...recovery, stoppedAt: Date.now() } },
      { where: recoveryMatches(recovery) }
    );
    await finishRecovery(latest.id, Date.now());
  }
}

async function ingest(origin: CodeTaskRow, line: FxStreamLine) {
  if (line.type === "idle") {
    await ingestIdle(origin, line);
    return;
  }
  if (line.type === "turn_start") {
    await applied(origin, line.messageId);
  }
  if (line.type === "user_message") {
    await applied(origin, line.id);
  }
  const event = projectFxEvent(line);
  if (event) {
    await appendEvent(origin.id, event.type, event.data, {
      sourceKey: `fx:${line.cursor}`,
    });
  }
  if (line.type === "turn_end") {
    await recordTurnUsage(origin.id, line.cursor ?? 0, line.usage);
  }
  if (line.type !== "turn_end") {
    return;
  }
  const beforeSettlement = await getTaskRow(origin.id);
  if (!beforeSettlement) {
    return;
  }
  const hasPendingCommand = await settleTurnBeforePending(
    () =>
      settleTurnCommand(
        origin.id,
        line.messageId,
        beforeSettlement.appliedInstructionVersion
      ),
    async () => {
      const [pending] = await db()
        .select({ id: codeTaskCommands.id })
        .from(codeTaskCommands)
        .where(
          and(
            eq(codeTaskCommands.taskId, origin.id),
            inArray(codeTaskCommands.status, ["queued", "leased", "accepted"]),
            or(
              eq(codeTaskCommands.kind, "start"),
              eq(codeTaskCommands.kind, "steer")
            )
          )
        )
        .limit(1);
      return Boolean(pending);
    }
  );
  const current = await getTaskRow(origin.id);
  if (!current) {
    return;
  }
  if (
    current.status === "cancel_requested" &&
    line.stopReason === "cancelled" &&
    (cancelCommandOf(current) || current.execution.cancelProbeId)
  ) {
    // The turn ended because of the dispatched cancellation order.
    await confirmCancellation(current.id, {
      commandId: cancelCommandOf(current),
      sourceKey: `cancelled:${line.cursor}`,
    });
    return;
  }
  await parkEndedTurn(origin.id, line, hasPendingCommand, current);
}

/**
 * A running turn ended without a verified result. The write is a CAS from
 * the exact running row that justified it; on a conflict the row is read
 * once more and the decision recomputed, so a cancellation or new
 * instruction committed in between is never overwritten.
 */
async function parkEndedTurn(
  taskId: string,
  line: Extract<FxStreamLine, { type: "turn_end" }>,
  hasPendingCommand: boolean,
  first: CodeTaskRow
) {
  let current: CodeTaskRow | undefined = first;
  for (let attempt = 0; attempt < 2 && current; attempt += 1) {
    const attentionMessage = terminalAttentionMessage(
      line,
      current,
      hasPendingCommand
    );
    if (!attentionMessage) {
      return;
    }
    // A turn_end is the session's own record that the turn stopped; a
    // recovery waiting for that confirmation is resolved by it.
    const recovery = activeRecovery(current.execution);
    // biome-ignore lint/performance/noAwaitInLoops: a single re-read after a lost CAS.
    const parked = await transitionTask(taskId, {
      expectedVersion: current.version,
      from: ["running"],
      patch: { error: attentionMessage },
      ...(recovery
        ? {
            runtime: {
              recovery: {
                ...recovery,
                outcome: "turn_ended",
                resolvedAt: Date.now(),
                stoppedAt: Date.now(),
              },
            },
          }
        : {}),
      to: "needs_attention",
    });
    if (parked) {
      await appendEvent(
        taskId,
        "task.needs_attention",
        { action: "send_correction", message: attentionMessage },
        { sourceKey: `attention:${line.cursor}` }
      );
      return;
    }
    current = await getTaskRow(taskId);
  }
}

export async function codeTaskTick(id: string) {
  await dispatchCodeCommands();
  await projectTask(id);
  await refreshCodeTaskCosts(id).catch(() => undefined);
  await notifyCodeResult(id).catch(() => undefined);
  const task = await getTaskRow(id);
  return (
    !task ||
    [
      "ready",
      "cancelled",
      "failed",
      "needs_attention",
      "waiting_for_input",
    ].includes(task.status)
  );
}

/**
 * Runtime silence that makes a running/cancelling task suspect. A healthy
 * runtime renews its heartbeat on every model request and host tool call;
 * the longest single host operation is a 120 s shell command and a World
 * delivery stops before 240 s, so 15 minutes of silence is far outside
 * normal operation. Stream projection never counts as activity.
 */
export const RUNTIME_SILENCE_MS = 15 * 60_000;
/**
 * How long to wait for a stop probe before asking the session to stop
 * again. Elapsed time only triggers another stop request; it is never
 * evidence that the runtime stopped, and it never releases anything.
 */
export const STOP_RETRY_MS = 5 * 60_000;

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Last real runtime activity. Legacy rows without a heartbeat fall back to updatedAt. */
export function lastRuntimeActivity(task: CodeTaskRow): number {
  const { execution } = task;
  const heartbeat = numberField(execution.runtimeHeartbeatAt);
  return Math.max(
    heartbeat ?? task.updatedAt.getTime(),
    numberField(execution.startedAt) ?? task.createdAt.getTime(),
    numberField(execution.cancelRequestedAt) ?? 0
  );
}

function recoveryMatches(recovery: Record<string, unknown>) {
  return sql`${codeTasks.execution}->'recovery'->>'since' = ${String(recovery.since)}`;
}

async function hasPendingDispatch(taskId: string): Promise<boolean> {
  const [pending] = await db()
    .select({ id: codeTaskCommands.id })
    .from(codeTaskCommands)
    .where(
      and(
        eq(codeTaskCommands.taskId, taskId),
        inArray(codeTaskCommands.status, ["queued", "leased"])
      )
    )
    .limit(1);
  return Boolean(pending);
}

function publicationLeaseHeld(task: CodeTaskRow, now: number): boolean {
  return Boolean(
    task.leaseToken && (!task.leaseUntil || task.leaseUntil.getTime() > now)
  );
}

/**
 * Fence a silent runtime: the task stays running/cancel_requested (its slot
 * and workspace are kept) with phase `recovering`, and the generation bump
 * makes every broker point reject the old runtime. The CAS includes the
 * observed heartbeat, so a runtime admitted concurrently wins over the fence.
 */
async function enterRecovery(
  task: CodeTaskRow,
  now: number
): Promise<CodeTaskRow | null> {
  const generation = executionGeneration(task.execution) + 1;
  const heartbeat = task.execution.runtimeHeartbeatAt;
  const fenced = await transitionTask(task.id, {
    expectedVersion: task.version,
    from: [task.status],
    patch: { phase: "recovering" },
    runtime: {
      executionGeneration: generation,
      recovery: {
        fromStatus: task.status,
        generation,
        reason: "runtime_silent",
        since: now,
      },
    },
    unfenced: true,
    where:
      typeof heartbeat === "number"
        ? sql`${codeTasks.execution}->>'runtimeHeartbeatAt' = ${String(heartbeat)}`
        : sql`${codeTasks.execution}->'runtimeHeartbeatAt' is null`,
  });
  if (fenced) {
    await appendEvent(
      task.id,
      "task.recovering",
      {
        message:
          "The coding agent stopped reporting progress. Busy is stopping it before releasing the task.",
      },
      { sourceKey: `recovering:${generation}` }
    );
  }
  return fenced;
}

function probeIdsOf(recovery: Record<string, unknown>): string[] {
  const ids = Array.isArray(recovery.probeIds) ? recovery.probeIds : [];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Ask the durable session to stop and record the probe that confirms it.
 * Without an answer the request is repeated every STOP_RETRY_MS; every probe
 * issued for this recovery stays valid as confirmation.
 */
async function requestStop(task: CodeTaskRow, now: number): Promise<void> {
  const recovery = activeRecovery(task.execution);
  const requestedAt = recovery ? numberField(recovery.stopRequestedAt) : null;
  if (
    !recovery ||
    recovery.stoppedAt ||
    (requestedAt !== null && now - requestedAt < STOP_RETRY_MS)
  ) {
    return;
  }
  if (!task.durableSessionId) {
    // No session was ever associated: no runtime can exist.
    await patchRuntimeExecution(
      task.id,
      { recovery: { ...recovery, stoppedAt: now, stopRequestedAt: now } },
      { where: recoveryMatches(recovery) }
    );
    return;
  }
  const agents = await codeAgents();
  const session = agents[task.billing].session(
    task.durableSessionId,
    settings(task)
  );
  await session.cancel();
  const accepted = await session.resume().accepted;
  await patchRuntimeExecution(
    task.id,
    {
      recovery: {
        ...recovery,
        probeId: accepted.messageId,
        probeIds: [...probeIdsOf(recovery), accepted.messageId],
        stopRequestedAt: now,
        stopRequests: (numberField(recovery.stopRequests) ?? 0) + 1,
      },
    },
    { where: recoveryMatches(recovery) }
  );
}

/**
 * Resolve a recovery only once the durable session confirmed the stop (its
 * stop probe came back idle) or never existed. Only then does the task
 * become terminal, release its reservation and get finishedAt. The
 * workspace is untouched: retention cleanup never forces an open run.
 */
async function finishRecovery(taskId: string, now: number): Promise<boolean> {
  const task = await getTaskRow(taskId);
  const recovery = task ? activeRecovery(task.execution) : null;
  if (
    !(
      task &&
      recovery &&
      ["running", "cancel_requested"].includes(task.status)
    ) ||
    publicationLeaseHeld(task, now)
  ) {
    return false;
  }
  // Only a confirmed stop resolves a recovery. Without it the task stays
  // visibly recovering and keeps its slot, reservation and workspace, no
  // matter how long the fence has been in place.
  if (!recovery.stoppedAt) {
    return false;
  }
  const cancelled = task.status === "cancel_requested";
  const outcome = "stop_confirmed";
  const message = cancelled
    ? "Cancelled. The agent was stopped by Busy's recovery."
    : "The coding agent stopped responding. Send a correction to continue.";
  const resolved = await transitionTask(task.id, {
    expectedVersion: task.version,
    from: [task.status],
    patch: cancelled ? {} : { error: message },
    runtime: {
      cancelDispatching: false,
      recovery: { ...recovery, outcome, resolvedAt: now },
    },
    to: cancelled ? "cancelled" : "needs_attention",
    where: recoveryMatches(recovery),
  });
  if (!resolved) {
    return false;
  }
  await reconcileOrphanCommands(
    task.id,
    `Reconciled after recovery (${outcome}).`
  );
  await appendEvent(
    task.id,
    cancelled ? "task.cancelled" : "task.needs_attention",
    cancelled ? { outcome } : { action: "send_correction", message, outcome },
    { sourceKey: `recovered:${String(recovery.generation)}` }
  );
  return true;
}

/** One idempotent supervision pass over running and cancelling tasks. */
export async function superviseCodeTasks(now = Date.now()) {
  const candidates = await db()
    .select()
    .from(codeTasks)
    .where(inArray(codeTasks.status, ["running", "cancel_requested"]))
    .orderBy(asc(codeTasks.updatedAt))
    .limit(50);
  let recovering = 0;
  let resolved = 0;
  for (const task of candidates) {
    try {
      if (activeRecovery(task.execution)) {
        // biome-ignore lint/performance/noAwaitInLoops: each task is reconciled under its own CAS.
        if (await finishRecovery(task.id, now)) {
          resolved += 1;
        } else {
          await requestStop(task, now);
        }
        continue;
      }
      if (
        now - lastRuntimeActivity(task) < RUNTIME_SILENCE_MS ||
        publicationLeaseHeld(task, now) ||
        (await hasPendingDispatch(task.id))
      ) {
        continue;
      }
      const fenced = await enterRecovery(task, now);
      if (fenced) {
        recovering += 1;
        await requestStop(fenced, now).catch(() => undefined);
        const latest = await getTaskRow(task.id);
        if (latest && activeRecovery(latest.execution)?.stoppedAt) {
          resolved += (await finishRecovery(task.id, now)) ? 1 : 0;
        }
      }
    } catch (error) {
      console.error("code-task.supervise_failed", {
        error: error instanceof Error ? error.message : "unknown",
        taskId: task.id,
      });
    }
  }
  return { recovering, resolved };
}

/** SQL key of the notification a task currently owes: revision, instruction and status. */
export const notificationKeySql = sql`${codeTasks.revision}::text || ':' || ${codeTasks.instructionVersion}::text || ':' || ${codeTasks.status}`;

export async function recoverCodeTasks(options: { now?: number } = {}) {
  const now = options.now ?? Date.now();
  await dispatchCodeCommands();
  const tasks = await db()
    .select({ id: codeTasks.id })
    .from(codeTasks)
    .where(inArray(codeTasks.status, ["running", "cancel_requested"]))
    .limit(20);
  await Promise.allSettled(tasks.map((task) => projectTask(task.id)));
  const supervision = await superviseCodeTasks(now);
  // Outbox: every status transition still owed. A legacy marker (no key)
  // covers its instruction version; a keyed marker covers one exact status.
  const terminal = await db()
    .select({ id: codeTasks.id })
    .from(codeTasks)
    .where(
      and(
        inArray(codeTasks.status, [
          "ready",
          "failed",
          "waiting_for_input",
          "needs_attention",
          "cancelled",
        ]),
        sql`case when ${codeTasks.execution}->'notification'->>'key' is not null
          then ${codeTasks.execution}->'notification'->>'key' <> ${notificationKeySql}
          else coalesce((${codeTasks.execution}->>'notificationInstructionVersion')::integer, 0) < ${codeTasks.instructionVersion}
        end`
      )
    )
    .orderBy(sql`${codeTasks.updatedAt} desc`)
    .limit(50);
  await Promise.allSettled(terminal.map((task) => notifyCodeResult(task.id)));
  const pendingCosts = await db()
    .select({ id: codeTasks.id })
    .from(codeTasks)
    .where(
      sql`${codeTasks.execution}->'usage'->>'costStatus' in ('pending', 'partial', 'unavailable')`
    )
    .orderBy(sql`${codeTasks.updatedAt} desc`)
    .limit(20);
  await Promise.allSettled(
    pendingCosts.map((task) => refreshCodeTaskCosts(task.id))
  );
  return { followed: tasks.length, ...supervision };
}

/**
 * The follow workflow ran out of ticks. Record it; the minute cron's
 * supervision remains responsible for the task, so this is not a state change.
 */
export async function recordFollowEnded(id: string): Promise<void> {
  const task = await getTaskRow(id);
  if (!task || isTerminalTaskStatus(task.status)) {
    return;
  }
  await patchRuntimeExecution(id, { followEndedAt: Date.now() });
  await appendEvent(
    id,
    "workflow.follow_ended",
    { status: task.status },
    { sourceKey: `follow-ended:${task.version}` }
  );
}
