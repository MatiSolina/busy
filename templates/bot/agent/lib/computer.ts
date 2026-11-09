import { hubFetch } from "./hub";

// The bot's side of the hub's computer handshake (apps/hub/app/api/bot/live). It imports only ./hub:
// request_login (a workflow tool) uses it from a step, and its module must not load step-only state.

const HUB_TIMEOUT_MS = 5000;
/** A claim the hub couldn't answer is retried once; a denial is final. */
const CLAIM_ATTEMPTS = 2;

/** One handshake call. Null when the hub can't answer (down, an error status, a non-object). */
async function computerCall(
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  try {
    const res = await hubFetch("/api/bot/live", {
      body: JSON.stringify(body),
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(HUB_TIMEOUT_MS)])
        : AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    const json: unknown = await res.json();
    return typeof json === "object" && json !== null
      ? (json as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The hub's permission to stop this session's computer, bound to it. `claim: null` means the hub
 * doesn't coordinate this session (a consultation, a fireside, a replaced chat session).
 */
export interface ShutdownClaim {
  claim: string | null;
  generation: number | null;
  sessionId: string;
}

/**
 * Asks the hub for the shutdown claim. Null means don't stop: the user is watching, a message or a
 * login keeps it on, the hub denied it, or it couldn't answer verifiably. The sandbox's own
 * timeout then ends an idle computer: a slower degradation, never a blind stop.
 */
export async function claimShutdown(
  sessionId: string,
  signal?: AbortSignal
): Promise<ShutdownClaim | null> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one bounded retry when the hub didn't answer.
    const res = await computerCall({ action: "claim", sessionId }, signal);
    if (res === null) {
      continue;
    }
    if (res.ok !== true) {
      return null;
    }
    if (res.claim === null && res.generation === null) {
      return { claim: null, generation: null, sessionId };
    }
    if (typeof res.claim === "string" && Number.isInteger(res.generation)) {
      return {
        claim: res.claim,
        generation: res.generation as number,
        sessionId,
      };
    }
    return null;
  }
  return null;
}

/**
 * Re-checks the claim (`verify`) or commits it (`commit`, right before `sandbox.stop()`). False
 * unless the hub confirms: Live opening, a delivery or a login hold since the claim invalidate it.
 */
export async function confirmShutdown(
  lease: ShutdownClaim,
  action: "commit" | "verify",
  signal?: AbortSignal
): Promise<boolean> {
  const res = await computerCall({ action, ...lease }, signal);
  return res?.ok === true;
}

/** Drops the claim (best effort: the hub lets a stale claim be taken over). */
export async function releaseShutdown(lease: ShutdownClaim): Promise<void> {
  if (lease.claim !== null) {
    await computerCall({ action: "release", ...lease });
  }
}

/**
 * request_login's hold: the hub keeps this session's computer (bounded) while the user logs in, and
 * extends its timeout with the Sandbox SDK. False when the hub didn't take it; never throws.
 */
export async function holdComputer(
  sessionId: string,
  hold: boolean
): Promise<boolean> {
  const res = await computerCall({
    action: hold ? "hold" : "unhold",
    sessionId,
  });
  return res?.ok === true;
}

/** Tells the hub this session's real sandbox name (H-18). Best effort: the hub has a fallback. */
export async function reportComputer(
  sessionId: string,
  name: string
): Promise<void> {
  const res = await computerCall({ action: "sandbox", name, sessionId });
  if (res?.ok !== true) {
    console.warn("computer: the hub did not store the sandbox name", {
      sessionId,
    });
  }
}
