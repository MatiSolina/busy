import { getVercelOidcToken } from "@vercel/oidc";
import { need } from "../env";
import type { BotCall } from "../eve/client";
import { isRoutineRunId, signRoutineToken } from "../hub-token";

/**
 * Build the hub → bot client for one routine occurrence.
 *
 * Production signs a short-lived token whose service principal includes the
 * stable run id. Local development still authenticates the relay with the
 * developer's Vercel OIDC token; the relay verifies that request and signs the
 * routine token itself, so the private hub key never leaves the hub.
 */
export function routineBotCall(slug: string, runId: string): BotCall {
  if (!isRoutineRunId(runId)) {
    throw new Error("Routine run id must be a UUID.");
  }
  const relay = process.env.DEV_RELAY_URL;
  if (relay) {
    return {
      headers: { "x-busy-routine-run": runId.toLowerCase() },
      token: () => getVercelOidcToken(),
      url: `${relay}/api/dev/bots/${slug}`,
    };
  }
  return {
    token: () => signRoutineToken(slug, runId),
    url: `https://${slug}.${need("BOTS_DOMAIN")}`,
  };
}
