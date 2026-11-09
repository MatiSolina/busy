export type RoutineRunStatus =
  | "pending"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "cancelled";

/** Why an occurrence was not run: the previous one was still active, or was a duplicate. */
export type RoutineSkipReason =
  | "active_run"
  | "awaiting_input"
  | "duplicate_occurrence";

export interface PublicRoutineRun {
  /** Set while a `dispatched` run's turn waits for an answer, approval or sign-in. */
  awaitingInputSince?: string | null;
  deliveryId: string | null;
  error: string | null;
  finishedAt: string | null;
  id: string;
  scheduledFor: string;
  startedAt: string | null;
  status: RoutineRunStatus;
}

export interface PublicRoutineSkips {
  count: number;
  lastAt: string | null;
  lastReason: RoutineSkipReason | null;
}

export interface PublicRoutine {
  daysOfWeek: number[];
  enabled: boolean;
  id: string;
  lastRun: PublicRoutineRun | null;
  name: string;
  prompt: string;
  /** Occurrences not run because an earlier one was still active. */
  skipped?: PublicRoutineSkips;
  time: string;
  timeZone: string;
}

export class RoutineNotFoundError extends Error {
  constructor() {
    super("Routine not found.");
  }
}

export class RoutineConflictError extends Error {
  constructor(message = "This routine conflicts with an existing routine.") {
    super(message);
  }
}
