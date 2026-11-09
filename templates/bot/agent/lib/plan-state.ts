import { defineState } from "eve/context";
import { isConsultation, isRoutineExecution } from "./caller";
import { isCodeTaskCompletion } from "./code-task-guards";
import {
  PLAN_DISPATCH_LIMIT,
  type PlanExecution,
  type PlanExecutionKind,
  type PlanExecutionOwner,
  type PlanExecutionStatus,
  type PlanStep,
  planStepProblems,
  type TaskPlan,
} from "./task-plan";

// Eve checkpoints these slots with the session; they are not process or sandbox state.
export const planState = defineState<TaskPlan | null>(
  "busy.task-plan.v1",
  () => null
);

export interface PlanExecutionBudget {
  activeExecutionIds: string[];
  dispatchesThisTurn: number;
  planId: string | null;
  totalDispatches: number;
  turnId: string | null;
}

/** Small, server-enforced fan-out limits for root-owned plan delegation. */
export const PLAN_EXECUTION_LIMITS = {
  active: 8,
  perRootTurn: 4,
  total: PLAN_DISPATCH_LIMIT,
} as const;
const PEER_TASK_NAME = /^peer-(?:[1-9]|1[0-2])$/u;

export const planExecutionBudget = defineState<PlanExecutionBudget>(
  "busy.task-plan-budget.v1",
  () => ({
    activeExecutionIds: [],
    dispatchesThisTurn: 0,
    planId: null,
    totalDispatches: 0,
    turnId: null,
  })
);

export type PlanRecoveryCheck = "unread" | "absent" | "restored";
export const planRecoveryCheck = defineState<PlanRecoveryCheck>(
  "busy.task-plan-recovery-check.v1",
  () => "unread"
);

/** Root-session task observations make bind_plan_execution server-verifiable. */
export const observedPlanTasks = defineState<RunningTaskLike[]>(
  "busy.task-plan-observed-tasks.v1",
  () => []
);

interface PlanSession {
  auth: Parameters<typeof isConsultation>[0];
  parent?: unknown;
}

export function canManagePlan(session: PlanSession): boolean {
  return !(
    session.parent ||
    isConsultation(session.auth) ||
    isRoutineExecution(session.auth) ||
    isCodeTaskCompletion(session.auth)
  );
}

export interface BindPlanExecutionInput {
  kind: PlanExecutionKind;
  owner: PlanExecutionOwner;
  planId: string;
  preDispatch?: boolean;
  revision: number;
  stepId: string;
  taskId: string;
}

export interface PlanExecutionEvent {
  callId?: string;
  childSessionId?: string;
  error?: string;
  eventKey: string;
  kind?: string;
  name?: string;
  outcome?: string;
  output?: unknown;
  reason?: string;
  taskId?: string;
  type:
    | "call.settled"
    | "call.started"
    | "child.opened"
    | "task.ended"
    | "task.started";
}

export interface PlanMutation {
  changed: boolean;
  execution?: PlanExecution;
  plan: TaskPlan;
}

function executionId(
  planId: string,
  stepId: string,
  revision: number,
  taskId: string
): string {
  const digest = stableDigest(
    `busy-plan-execution\0${planId}\0${stepId}\0${revision}\0${taskId}`
  );
  return `exec-${digest}`;
}

// Deterministic, workflow-safe identifier digest. It is an identity key, not
// a security token; authorization is checked separately against Eve state.
function stableDigest(value: string): string {
  const modulus = 1_000_000_007;
  let first = 2_166_136_261 % modulus;
  let second = 1_664_525;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    first = (first * 31 + code) % modulus;
    second = (second * 37 + code + 31) % modulus;
  }
  return `${first.toString(16).padStart(8, "0")}${second
    .toString(16)
    .padStart(8, "0")}`;
}

export function stablePlanExecutionId(input: {
  planId: string;
  revision: number;
  stepId: string;
  taskId: string;
}): string {
  return executionId(input.planId, input.stepId, input.revision, input.taskId);
}

export function stablePlanDispatchTaskId(
  sessionId: string,
  callId: string
): string {
  const digest = stableDigest(`busy-plan-dispatch\0${sessionId}\0${callId}`);
  return `dispatch-${digest}`;
}

function normalizeBudget(
  budget: PlanExecutionBudget,
  plan: TaskPlan,
  turnId: string | undefined
): PlanExecutionBudget {
  const durableDispatches = Math.min(
    Math.max(plan.dispatchCount ?? 0, 0),
    PLAN_DISPATCH_LIMIT
  );
  const nextTurn = turnId ?? null;
  if (budget.planId !== plan.id) {
    return {
      activeExecutionIds: [],
      dispatchesThisTurn: 0,
      planId: plan.id,
      totalDispatches: durableDispatches,
      turnId: nextTurn,
    };
  }
  const totalDispatches = Math.max(budget.totalDispatches, durableDispatches);
  if (budget.turnId === nextTurn) {
    return totalDispatches === budget.totalDispatches
      ? budget
      : { ...budget, totalDispatches };
  }
  return {
    ...budget,
    dispatchesThisTurn: 0,
    totalDispatches,
    turnId: nextTurn,
  };
}

function hasCompletedDependencies(plan: TaskPlan, step: PlanStep): boolean {
  const byId = new Map(
    plan.steps.map((candidate) => [candidate.id, candidate])
  );
  return step.dependsOn.every(
    (dependency) => byId.get(dependency)?.status === "completed"
  );
}

function activeExecution(status: PlanExecutionStatus): boolean {
  return status === "bound" || status === "running";
}

function outputEvidence(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    return "Settled result available for root verification.";
  }
  return "Settled structured result available for root verification.";
}

export interface RunningTaskLike {
  callId: string;
  kind: string;
  name: string;
  status: string;
  taskId: string;
  turnId?: string;
}

function taskNameMatchesKind(
  kind: PlanExecutionKind,
  observation: RunningTaskLike | undefined
): boolean {
  if (kind === "code") {
    return true;
  }
  if (observation?.status !== "running") {
    return false;
  }
  if (observation.kind !== "agent") {
    return false;
  }
  return kind === "peer"
    ? PEER_TASK_NAME.test(observation.name)
    : observation.name === "agent" || observation.name === "agentWithModel";
}

interface PlanExecutionMutation {
  budget: PlanExecutionBudget;
  mutation: PlanMutation;
}

function requirePlan(current: TaskPlan | null, planId: string): TaskPlan {
  if (!current || current.id !== planId) {
    throw new Error("Plan not found in this session. Get the current plan.");
  }
  return current;
}

function requirePlanStep(plan: TaskPlan, stepId: string): PlanStep {
  const step = plan.steps.find(({ id }) => id === stepId);
  if (!step) {
    throw new Error("Plan step not found.");
  }
  return step;
}

function isSameTaskBinding(
  execution: PlanExecution | undefined,
  input: BindPlanExecutionInput
): execution is PlanExecution {
  return (
    execution?.taskId === input.taskId &&
    execution.kind === input.kind &&
    execution.owner.sessionId === input.owner.sessionId
  );
}

function isSameDispatchReservation(
  execution: PlanExecution | undefined,
  input: BindPlanExecutionInput
): execution is PlanExecution {
  return (
    input.preDispatch === true &&
    execution !== undefined &&
    execution.owner.callId === input.owner.callId &&
    execution.kind === input.kind &&
    execution.dispatchKey === input.taskId &&
    activeExecution(execution.status)
  );
}

function replayedBinding(
  plan: TaskPlan,
  step: PlanStep,
  budget: PlanExecutionBudget,
  input: BindPlanExecutionInput
): PlanExecutionMutation | undefined {
  const { execution } = step;
  if (
    isSameTaskBinding(execution, input) ||
    isSameDispatchReservation(execution, input)
  ) {
    return {
      budget: normalizeBudget(budget, plan, input.owner.turnId),
      mutation: {
        changed: false,
        execution,
        plan,
      },
    };
  }
  return undefined;
}

function assertBindableStep(
  plan: TaskPlan,
  step: PlanStep,
  revision: number
): void {
  if (plan.revision !== revision) {
    throw new Error("Plan revision changed. Get it before binding again.");
  }
  if (step.execution) {
    throw new Error("This step already has a different execution binding.");
  }
  if (
    step.status === "completed" ||
    step.status === "cancelled" ||
    step.status === "failed" ||
    step.status === "blocked"
  ) {
    throw new Error("Only a pending or in-progress step can be delegated.");
  }
  if (!hasCompletedDependencies(plan, step)) {
    throw new Error("Complete dependencies before binding this step.");
  }
}

function bindingTargetError(kind: PlanExecutionKind): string {
  if (kind === "peer") {
    return "A peer binding must reference a running peer task.";
  }
  if (kind === "code") {
    return "A code binding must use the code-task helper.";
  }
  return "An agent binding must reference a running agent task.";
}

function assertBindingTarget(
  input: BindPlanExecutionInput,
  taskObservation: RunningTaskLike | undefined
): void {
  if (
    !(input.preDispatch || taskNameMatchesKind(input.kind, taskObservation))
  ) {
    throw new Error(bindingTargetError(input.kind));
  }
  if (
    !input.preDispatch &&
    taskObservation?.turnId !== undefined &&
    taskObservation.turnId !== input.owner.turnId
  ) {
    throw new Error("That task belongs to a different root turn.");
  }
}

function assertBudgetAvailable(budget: PlanExecutionBudget): void {
  if (budget.totalDispatches >= PLAN_EXECUTION_LIMITS.total) {
    throw new Error("Plan execution budget exhausted.");
  }
  if (budget.dispatchesThisTurn >= PLAN_EXECUTION_LIMITS.perRootTurn) {
    throw new Error("Root-turn plan execution budget exhausted.");
  }
  if (budget.activeExecutionIds.length >= PLAN_EXECUTION_LIMITS.active) {
    throw new Error("Too many plan executions are active.");
  }
}

function createBoundExecution(
  plan: TaskPlan,
  step: PlanStep,
  input: BindPlanExecutionInput,
  taskObservation: RunningTaskLike | undefined
): PlanExecution {
  return {
    ...(input.preDispatch ? { dispatchKey: input.taskId } : {}),
    id: executionId(plan.id, step.id, plan.revision, input.taskId),
    kind: input.kind,
    owner: { ...input.owner },
    planRevision: plan.revision + 1,
    status: "bound",
    ...(input.preDispatch ? {} : { taskId: input.taskId }),
    ...(taskObservation?.callId ? { callId: taskObservation.callId } : {}),
  };
}

function applyBinding(
  plan: TaskPlan,
  step: PlanStep,
  execution: PlanExecution,
  input: BindPlanExecutionInput
): TaskPlan {
  return {
    ...plan,
    revision: plan.revision + 1,
    steps: plan.steps.map((candidate) =>
      candidate.id === step.id
        ? {
            ...candidate,
            execution,
            status: "in_progress" as const,
            ...(input.preDispatch
              ? { taskId: undefined }
              : { taskId: input.taskId }),
          }
        : candidate
    ),
  };
}

/**
 * Bind a root-owned step to a real Eve task (or to a Busy code-task id). The
 * same binding is idempotent, while a different task or stale revision fails.
 */
export function bindPlanExecution(
  current: TaskPlan | null,
  budget: PlanExecutionBudget,
  input: BindPlanExecutionInput,
  taskObservation?: RunningTaskLike
): { budget: PlanExecutionBudget; mutation: PlanMutation } {
  const plan = requirePlan(current, input.planId);
  const step = requirePlanStep(plan, input.stepId);
  const replay = replayedBinding(plan, step, budget, input);
  if (replay) {
    return replay;
  }
  assertBindableStep(plan, step, input.revision);
  assertBindingTarget(input, taskObservation);

  const normalized = normalizeBudget(budget, plan, input.owner.turnId);
  assertBudgetAvailable(normalized);

  const execution = createBoundExecution(plan, step, input, taskObservation);
  const nextPlan = {
    ...applyBinding(plan, step, execution, input),
    dispatchCount: normalized.totalDispatches + 1,
  };
  const problems = planStepProblems(nextPlan.steps);
  if (problems.length > 0) {
    throw new Error(problems[0]);
  }
  return {
    budget: {
      ...normalized,
      activeExecutionIds: [...normalized.activeExecutionIds, execution.id],
      dispatchesThisTurn: normalized.dispatchesThisTurn + 1,
      totalDispatches: normalized.totalDispatches + 1,
    },
    mutation: { changed: true, execution, plan: nextPlan },
  };
}

function matchesExecutionCall(
  execution: PlanExecution,
  event: PlanExecutionEvent
): boolean {
  if (!event.callId || execution.kind === "code") {
    return false;
  }
  return (
    execution.callId === event.callId ||
    (execution.dispatchKey !== undefined &&
      execution.owner.callId === event.callId)
  );
}

function findExecution(
  plan: TaskPlan,
  event: PlanExecutionEvent
): { execution: PlanExecution; step: PlanStep } | undefined {
  for (const step of plan.steps) {
    const { execution } = step;
    if (!execution) {
      continue;
    }
    if (
      (event.taskId &&
        (execution.taskId === event.taskId ||
          execution.dispatchKey === event.taskId)) ||
      matchesExecutionCall(execution, event)
    ) {
      return { execution, step };
    }
  }
  return undefined;
}

function terminalStatus(
  event: PlanExecutionEvent
): { status: PlanExecutionStatus; reason?: string } | undefined {
  if (event.type === "task.ended") {
    if (event.outcome === "completed") {
      return { status: "completed" };
    }
    if (event.outcome === "cancelled") {
      return {
        reason:
          "Delegated task cancelled. Inspect its recorded result before retrying.",
        status: "blocked",
      };
    }
    return {
      reason:
        "Delegated task failed. Inspect its recorded result before retrying.",
      status: "failed",
    };
  }
  if (event.type !== "call.settled") {
    return undefined;
  }
  if (event.outcome === "completed") {
    return { status: "completed" };
  }
  if (
    event.outcome === "interrupted" ||
    event.outcome === "abandoned" ||
    event.outcome === "rejected" ||
    event.outcome === "cancelled"
  ) {
    return {
      reason:
        "Delegated call did not complete. Inspect its recorded result before retrying.",
      status: "blocked",
    };
  }
  return {
    reason:
      "Delegated call failed. Inspect its recorded result before retrying.",
    status: "failed",
  };
}

function blockDependents(steps: readonly PlanStep[], failedId: string) {
  const blocked = new Set<string>([failedId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (
        !blocked.has(step.id) &&
        step.status === "pending" &&
        step.dependsOn.some((dependency) => blocked.has(dependency))
      ) {
        blocked.add(step.id);
        changed = true;
      }
    }
  }
  return blocked;
}

function budgetAfterExecution(
  budget: PlanExecutionBudget,
  executionKey: string,
  status: PlanExecutionStatus
): PlanExecutionBudget {
  if (activeExecution(status)) {
    if (budget.activeExecutionIds.includes(executionKey)) {
      return budget;
    }
    return {
      ...budget,
      activeExecutionIds: [...budget.activeExecutionIds, executionKey],
    };
  }
  return {
    ...budget,
    activeExecutionIds: budget.activeExecutionIds.filter(
      (id) => id !== executionKey
    ),
  };
}

interface ExecutionObservation {
  execution: PlanExecution;
  step: PlanStep;
}

function isTerminalExecution(status: PlanExecutionStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "blocked" ||
    status === "cancelled"
  );
}

function cannotOpenChildSession(status: PlanExecutionStatus): boolean {
  return status === "failed" || status === "blocked" || status === "cancelled";
}

function observeStartedExecution(
  execution: PlanExecution,
  step: PlanStep,
  event: PlanExecutionEvent
): ExecutionObservation | undefined {
  if (event.type !== "task.started" && event.type !== "call.started") {
    return undefined;
  }
  if (step.status === "cancelled") {
    return undefined;
  }
  const resumedCall =
    event.type === "call.started" &&
    execution.status === "completed" &&
    event.callId !== execution.callId;
  if (execution.status !== "bound" && !resumedCall) {
    return undefined;
  }
  return {
    execution: {
      ...execution,
      callId: event.callId ?? execution.callId,
      lastEventKey: event.eventKey,
      status: "running",
      ...(event.taskId ? { taskId: event.taskId } : {}),
    },
    step: {
      ...step,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      ...(resumedCall ? { status: "in_progress" as const } : {}),
    },
  };
}

function observeChildSession(
  execution: PlanExecution,
  step: PlanStep,
  event: PlanExecutionEvent
): ExecutionObservation | undefined {
  if (
    event.type !== "child.opened" ||
    cannotOpenChildSession(execution.status) ||
    execution.childSessionId === event.childSessionId
  ) {
    return undefined;
  }
  return {
    execution: {
      ...execution,
      childSessionId: event.childSessionId,
      lastEventKey: event.eventKey,
      status: execution.status === "bound" ? "running" : execution.status,
    },
    step,
  };
}

function observeTerminalExecution(
  execution: PlanExecution,
  step: PlanStep,
  event: PlanExecutionEvent
): ExecutionObservation | undefined {
  const terminal = terminalStatus(event);
  if (!terminal) {
    return undefined;
  }
  if (event.type === "task.ended" && isTerminalExecution(execution.status)) {
    return undefined;
  }
  const evidence = outputEvidence(event.output);
  const nextExecution: PlanExecution = {
    ...execution,
    ...(evidence ? { resultEvidence: evidence } : {}),
    ...(terminal.reason ? { failureReason: terminal.reason } : {}),
    lastEventKey: event.eventKey,
    status: terminal.status,
  };
  let nextStep = step;
  if (
    (terminal.status === "failed" || terminal.status === "blocked") &&
    step.status !== "cancelled" &&
    step.status !== "completed"
  ) {
    nextStep = {
      ...step,
      note: terminal.reason,
      status: terminal.status,
    };
  }
  const changed =
    nextExecution.status !== execution.status ||
    nextExecution.resultEvidence !== execution.resultEvidence ||
    nextExecution.failureReason !== execution.failureReason;
  return changed ? { execution: nextExecution, step: nextStep } : undefined;
}

function observeExecutionEvent(
  execution: PlanExecution,
  step: PlanStep,
  event: PlanExecutionEvent
): ExecutionObservation | undefined {
  if (event.type === "task.started" || event.type === "call.started") {
    return observeStartedExecution(execution, step, event);
  }
  if (event.type === "child.opened") {
    return observeChildSession(execution, step, event);
  }
  return observeTerminalExecution(execution, step, event);
}

function blockFailedDependents(
  steps: PlanStep[],
  failedStepId: string,
  failedStepStatus: PlanStep["status"]
): void {
  if (failedStepStatus === "completed") {
    return;
  }
  const blocked = blockDependents(steps, failedStepId);
  for (let index = 0; index < steps.length; index += 1) {
    const candidate = steps[index];
    if (
      candidate &&
      blocked.has(candidate.id) &&
      candidate.id !== failedStepId &&
      candidate.status === "pending"
    ) {
      steps[index] = {
        ...candidate,
        note: `Blocked by failed or blocked dependency ${failedStepId}.`,
        status: "blocked",
      };
    }
  }
}

function applyExecutionObservation(
  plan: TaskPlan,
  observedStep: PlanStep,
  observedExecution: PlanExecution
): TaskPlan {
  const nextSteps = plan.steps.map((candidate) =>
    candidate.id === observedStep.id
      ? { ...observedStep, execution: observedExecution }
      : candidate
  );
  if (
    observedExecution.status === "failed" ||
    observedExecution.status === "blocked"
  ) {
    blockFailedDependents(nextSteps, observedStep.id, observedStep.status);
  }
  return {
    ...plan,
    revision: plan.revision + 1,
    steps: nextSteps,
  };
}

/**
 * Applies only facts observed on the root session stream. Replayed facts are
 * idempotent by event position and terminal state. It never changes a step to
 * completed; a later root update must verify the result and provide evidence.
 */
export function observePlanExecution(
  current: TaskPlan | null,
  budget: PlanExecutionBudget,
  event: PlanExecutionEvent,
  rootSessionId?: string
): { budget: PlanExecutionBudget; mutation: PlanMutation } {
  if (!current) {
    return {
      budget,
      mutation: { changed: false, plan: current as unknown as TaskPlan },
    };
  }
  const found = findExecution(current, event);
  if (!found) {
    return { budget, mutation: { changed: false, plan: current } };
  }
  const { execution, step } = found;
  if (rootSessionId && execution.owner.sessionId !== rootSessionId) {
    return { budget, mutation: { changed: false, execution, plan: current } };
  }
  if (execution.lastEventKey === event.eventKey) {
    return {
      budget,
      mutation: { changed: false, execution, plan: current },
    };
  }
  const observation = observeExecutionEvent(execution, step, event);
  if (!observation) {
    return {
      budget,
      mutation: { changed: false, execution, plan: current },
    };
  }

  const nextPlan = applyExecutionObservation(
    current,
    observation.step,
    observation.execution
  );
  const nextBudget = budgetAfterExecution(
    {
      ...budget,
      totalDispatches: Math.max(
        budget.totalDispatches,
        current.dispatchCount ?? 0
      ),
    },
    execution.id,
    observation.execution.status
  );
  return {
    budget: nextBudget,
    mutation: {
      changed: true,
      execution: observation.execution,
      plan: nextPlan,
    },
  };
}

export function resetPlanBudget(
  planId: string | null,
  durableDispatches = 0
): void {
  planExecutionBudget.update((current) => ({
    activeExecutionIds: [],
    dispatchesThisTurn: 0,
    planId,
    totalDispatches:
      planId === null
        ? 0
        : Math.min(Math.max(durableDispatches, 0), PLAN_DISPATCH_LIMIT),
    turnId: current.turnId,
  }));
}

export function recordObservedTaskStart(taskValue: RunningTaskLike): void {
  observedPlanTasks.update((current) =>
    [
      ...current.filter((candidate) => candidate.taskId !== taskValue.taskId),
      taskValue,
    ].slice(-64)
  );
}

export function recordObservedTaskEnd(taskId: string): void {
  observedPlanTasks.update((current) =>
    current.map((candidate) =>
      candidate.taskId === taskId
        ? { ...candidate, status: "ended" }
        : candidate
    )
  );
}

export function principalIdOf(session: PlanSession): string | undefined {
  const value = session.auth?.current?.principalId;
  return typeof value === "string" ? value : undefined;
}
