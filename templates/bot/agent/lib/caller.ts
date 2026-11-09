type Auth =
  | { current?: { principalType?: string; principalId?: string } | null }
  | null
  | undefined;

export type RoutineAuth =
  | { current?: { principalType?: unknown; principalId?: unknown } | null }
  | null
  | undefined;

/**
 * The principal eve's jwtEcdsa builds (`<iss>:<sub>`) for a consultation credential the hub
 * signs for one asking bot and one consulted bot (agent/lib/consultation-auth.ts,
 * apps/hub/lib/hub-token.ts). Only the hub's key can mint the `consultation:` subject.
 */
export const CONSULTATION_PRINCIPAL_PREFIX = "busy-hub:consultation:";

// Two ways another bot calls this one, both read-only and one hop:
// - the hub-signed consultation credential (H-26), whatever the principal type says;
// - legacy: the asking bot's own Vercel OIDC subject (`…:project:bot-<slug>:…`), accepted
//   while peers still send it (docs/consultations.md has the retirement step).
// The hub, routines, code-task notices, firesides and people never match.
export function isConsultation(auth: Auth): boolean {
  const principalId = auth?.current?.principalId;
  if (typeof principalId !== "string") {
    return false;
  }
  return (
    principalId.startsWith(CONSULTATION_PRINCIPAL_PREFIX) ||
    principalId.includes(":project:bot-")
  );
}

/** Scheduled runs use a service principal; prompt text cannot grant this identity. */
export function isRoutineExecution(auth: RoutineAuth): boolean {
  const current = auth?.current;
  return (
    current?.principalType === "service" &&
    typeof current.principalId === "string" &&
    current.principalId.startsWith("busy-hub:hub:routine:")
  );
}
