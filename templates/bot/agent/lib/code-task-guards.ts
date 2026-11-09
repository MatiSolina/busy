type CodeTaskAuth =
  | { current?: { principalType?: unknown; principalId?: unknown } | null }
  | null
  | undefined;

/** Completion deliveries are facts, not new user requests. */
export function isCodeTaskCompletion(auth: CodeTaskAuth): boolean {
  const current = auth?.current;
  return (
    current?.principalType === "service" &&
    typeof current.principalId === "string" &&
    (current.principalId === "busy-hub:hub:code-task" ||
      current.principalId.startsWith("busy-hub:hub:code-task:") ||
      current.principalId === "hub:code-task" ||
      current.principalId.startsWith("hub:code-task:"))
  );
}

export function codeTaskToolAvailable(
  auth: CodeTaskAuth,
  consultation: boolean,
  routineExecution: boolean
): boolean {
  return !(consultation || routineExecution || isCodeTaskCompletion(auth));
}
