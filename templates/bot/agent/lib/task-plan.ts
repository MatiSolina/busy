// Chat replay must work when only the hub's dependencies are installed.
export const PLAN_STEP_ID = /^[a-zA-Z0-9_-]{1,64}$/u;
export const PLAN_STEP_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
  "failed",
] as const;

export const PLAN_EXECUTION_KINDS = ["agent", "peer", "code"] as const;
export const PLAN_EXECUTION_STATUSES = [
  "bound",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;
/** Maximum number of server-authorized dispatches for one plan identity. */
export const PLAN_DISPATCH_LIMIT = 20 as const;

export type PlanExecutionKind = (typeof PLAN_EXECUTION_KINDS)[number];
export type PlanExecutionStatus = (typeof PLAN_EXECUTION_STATUSES)[number];

/** The server-owned identity of the root that bound delegated work. */
export interface PlanExecutionOwner {
  callId?: string;
  principalId?: string;
  sessionId: string;
  turnId?: string;
}

/**
 * A binding is deliberately separate from a step's business status. A native
 * task settling only proves that Eve observed the task; the root still has to
 * inspect the returned result before marking the step completed.
 */
export interface PlanExecution {
  callId?: string;
  childSessionId?: string;
  /** Pre-dispatch reservation key; replaced by the actual Eve task id later. */
  dispatchKey?: string;
  failureReason?: string;
  id: string;
  kind: PlanExecutionKind;
  lastEventKey?: string;
  owner: PlanExecutionOwner;
  planRevision: number;
  resultEvidence?: string;
  status: PlanExecutionStatus;
  /** Populated from task.started; absent only during pre-dispatch reservation. */
  taskId?: string;
}

export interface PlanStep {
  assignee: string;
  dependsOn: string[];
  execution?: PlanExecution;
  expectedResult: string;
  id: string;
  note?: string;
  status: (typeof PLAN_STEP_STATUSES)[number];
  taskId?: string;
  title: string;
}
export interface TaskPlan {
  /** Server-owned monotonic dispatch count; omitted only by legacy snapshots. */
  dispatchCount?: number;
  id: string;
  revision: number;
  steps: PlanStep[];
  title: string;
}

function dependencyProblems(
  step: PlanStep,
  byId: ReadonlyMap<string, PlanStep>
): string[] {
  const problems: string[] = [];
  if (new Set(step.dependsOn).size !== step.dependsOn.length) {
    problems.push("Dependencies must be unique.");
  }
  if (step.dependsOn.some((id) => id === step.id || !byId.has(id))) {
    problems.push("Dependencies must name other steps in this plan.");
  }
  if (
    (step.status === "in_progress" || step.status === "completed") &&
    step.dependsOn.some((id) => byId.get(id)?.status !== "completed")
  ) {
    problems.push(
      "Complete dependencies before starting or completing a step."
    );
  }
  return problems;
}

function noteProblem(step: PlanStep): string | undefined {
  if (step.note) {
    return undefined;
  }
  if (step.status === "failed") {
    return "Include a note with the execution failure.";
  }
  if (step.status === "blocked" || step.status === "completed") {
    return "Include a note with the blocker or evidence of completion.";
  }
  return undefined;
}

function delegatedCompletionProblem(step: PlanStep): string | undefined {
  if (
    step.status !== "completed" ||
    !step.execution ||
    (step.execution.status === "completed" && step.execution.resultEvidence)
  ) {
    return undefined;
  }
  return "A delegated step needs a settled execution result before completion.";
}

function executionTaskProblem(step: PlanStep): string | undefined {
  const { execution } = step;
  if (!execution || execution.planRevision <= 0) {
    return undefined;
  }
  if (execution.taskId !== undefined && step.taskId !== execution.taskId) {
    return "An execution binding must match its step task id.";
  }
  if (
    execution.status !== "bound" &&
    !execution.taskId &&
    !(execution.status === "blocked" && execution.dispatchKey)
  ) {
    return "An execution binding must match its step task id.";
  }
  return undefined;
}

function stepProblems(
  step: PlanStep,
  byId: ReadonlyMap<string, PlanStep>
): string[] {
  const problems = dependencyProblems(step, byId);
  const missingNote = noteProblem(step);
  if (missingNote) {
    problems.push(missingNote);
  }
  const incompleteExecution = delegatedCompletionProblem(step);
  if (incompleteExecution) {
    problems.push(incompleteExecution);
  }
  const mismatchedExecution = executionTaskProblem(step);
  if (mismatchedExecution) {
    problems.push(mismatchedExecution);
  }
  return problems;
}

function visitsDependencyCycle(
  id: string,
  byId: ReadonlyMap<string, PlanStep>,
  visited: Set<string>,
  visiting: Set<string>
): boolean {
  if (visiting.has(id)) {
    return true;
  }
  if (visited.has(id)) {
    return false;
  }
  visiting.add(id);
  const step = byId.get(id);
  const cyclic = step?.dependsOn.some((dependency) =>
    visitsDependencyCycle(dependency, byId, visited, visiting)
  );
  if (cyclic) {
    return true;
  }
  visiting.delete(id);
  visited.add(id);
  return false;
}

function hasDependencyCycle(
  steps: readonly PlanStep[],
  byId: ReadonlyMap<string, PlanStep>
): boolean {
  const visited = new Set<string>();
  const visiting = new Set<string>();
  return steps.some((step) =>
    visitsDependencyCycle(step.id, byId, visited, visiting)
  );
}

export function planStepProblems(steps: readonly PlanStep[]): string[] {
  const problems: string[] = [];
  const byId = new Map(steps.map((step) => [step.id, step]));
  if (byId.size !== steps.length) {
    problems.push("Step ids must be unique.");
  }
  for (const step of steps) {
    problems.push(...stepProblems(step, byId));
  }
  if (hasDependencyCycle(steps, byId)) {
    problems.push("Plan dependencies cannot contain a cycle.");
  }
  return problems;
}

export function planStatus(plan: TaskPlan) {
  if (plan.steps.every((step) => step.status === "completed")) {
    return "completed";
  }
  if (
    plan.steps.every(
      (step) => step.status === "completed" || step.status === "cancelled"
    )
  ) {
    return "cancelled";
  }
  return "active";
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= max
  );
}
const STEP_KEYS = new Set([
  "assignee",
  "dependsOn",
  "expectedResult",
  "execution",
  "id",
  "note",
  "status",
  "taskId",
  "title",
]);
const PLAN_KEYS = new Set([
  "dispatchCount",
  "id",
  "revision",
  "steps",
  "title",
]);
const STATUSES: ReadonlySet<unknown> = new Set(PLAN_STEP_STATUSES);
const EXECUTION_KINDS: ReadonlySet<unknown> = new Set(PLAN_EXECUTION_KINDS);
const EXECUTION_STATUSES: ReadonlySet<unknown> = new Set(
  PLAN_EXECUTION_STATUSES
);

function isExecutionOwner(value: unknown): value is PlanExecutionOwner {
  if (!record(value)) {
    return false;
  }
  return (
    text(value.sessionId, 200) &&
    (value.turnId === undefined || text(value.turnId, 200)) &&
    (value.callId === undefined || text(value.callId, 200)) &&
    (value.principalId === undefined || text(value.principalId, 300))
  );
}

function isPlanExecution(value: unknown): value is PlanExecution {
  if (!record(value)) {
    return false;
  }
  return (
    Object.keys(value).every((key) =>
      new Set([
        "dispatchKey",
        "id",
        "kind",
        "owner",
        "planRevision",
        "status",
        "taskId",
        "callId",
        "childSessionId",
        "resultEvidence",
        "lastEventKey",
        "failureReason",
      ]).has(key)
    ) &&
    text(value.id, 200) &&
    (value.dispatchKey === undefined || text(value.dispatchKey, 300)) &&
    EXECUTION_KINDS.has(value.kind) &&
    isExecutionOwner(value.owner) &&
    typeof value.planRevision === "number" &&
    Number.isSafeInteger(value.planRevision) &&
    value.planRevision > 0 &&
    EXECUTION_STATUSES.has(value.status) &&
    (value.taskId === undefined || text(value.taskId, 300)) &&
    (value.callId === undefined || text(value.callId, 300)) &&
    (value.childSessionId === undefined || text(value.childSessionId, 300)) &&
    (value.resultEvidence === undefined || text(value.resultEvidence, 4000)) &&
    (value.lastEventKey === undefined || text(value.lastEventKey, 300)) &&
    (value.failureReason === undefined || text(value.failureReason, 2000))
  );
}

function isPlanStep(value: unknown): value is PlanStep {
  if (!record(value)) {
    return false;
  }
  return (
    Object.keys(value).every((key) => STEP_KEYS.has(key)) &&
    text(value.id, 64) &&
    PLAN_STEP_ID.test(value.id) &&
    text(value.assignee, 100) &&
    text(value.title, 240) &&
    text(value.expectedResult, 1000) &&
    STATUSES.has(value.status) &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.length <= 20 &&
    value.dependsOn.every(
      (id) => typeof id === "string" && PLAN_STEP_ID.test(id)
    ) &&
    (value.execution === undefined || isPlanExecution(value.execution)) &&
    (value.note === undefined || text(value.note, 2000)) &&
    (value.taskId === undefined || text(value.taskId, 200))
  );
}

export function parseTaskPlan(output: unknown): TaskPlan | null {
  const plan = record(output) ? output.plan : null;
  if (
    !(
      record(plan) &&
      Object.keys(plan).every((key) => PLAN_KEYS.has(key)) &&
      (plan.dispatchCount === undefined ||
        (typeof plan.dispatchCount === "number" &&
          Number.isSafeInteger(plan.dispatchCount) &&
          plan.dispatchCount >= 0 &&
          plan.dispatchCount <= PLAN_DISPATCH_LIMIT)) &&
      text(plan.id, 100) &&
      text(plan.title, 200) &&
      typeof plan.revision === "number" &&
      Number.isSafeInteger(plan.revision) &&
      plan.revision > 0 &&
      Array.isArray(plan.steps) &&
      plan.steps.length > 0 &&
      plan.steps.length <= 20 &&
      plan.steps.every(isPlanStep)
    )
  ) {
    return null;
  }
  return planStepProblems(plan.steps).length === 0
    ? (plan as unknown as TaskPlan)
    : null;
}
