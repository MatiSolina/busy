import type { OutboundAuthFn } from "eve/agents/auth";
import type { VerifyJwtEcdsaConfig } from "eve/channels/auth";
import { type HubFetch, hubFetch } from "./hub";

// H-26: consultation credentials (docs/consultations.md). The hub signs one short-lived token per
// asking bot → consulted bot; the consulted bot verifies it with HUB_PUBLIC_KEY. Keep these
// constants in sync with apps/hub/lib/hub-token.ts.
// H-08 hook: the audience names the consulted bot by slug; switch both sides to the immutable
// bot id as one versioned change.
export const CONSULTATION_ISSUER = "busy-hub";
export const CONSULTATION_AUDIENCE_PREFIX = "busy-consultation:";
export const CONSULTATION_PURPOSE = "consultation";

/**
 * The receiving side: only hub-signed consultation tokens for this bot. eve's jwtEcdsa turns one
 * into the `busy-hub:consultation:<fromBotId>` service principal that isConsultation recognizes.
 */
export function consultationVerifier(
  slug: string,
  publicKey: string
): VerifyJwtEcdsaConfig {
  return {
    algorithm: "ES256",
    audiences: [`${CONSULTATION_AUDIENCE_PREFIX}${slug}`],
    claims: { busy_purpose: [CONSULTATION_PURPOSE] },
    issuer: CONSULTATION_ISSUER,
    publicKey,
    subjects: ["consultation:*"],
  };
}

/**
 * Transition switches, read from the bot project's environment. Order (docs/consultations.md):
 * 1. every bot deploys with the verifier (always on when HUB_PUBLIC_KEY is set);
 * 2. BUSY_CONSULTATION_CREDENTIALS=1 makes this bot send hub credentials instead of its OIDC;
 * 3. only after every bot sends them, BUSY_LEGACY_PEER_OIDC=off retires the OIDC wildcard.
 * Neither flag is set by the hub yet.
 */
export const sendsConsultationCredentials = (
  env: Record<string, string | undefined> = process.env
) => env.BUSY_CONSULTATION_CREDENTIALS === "1";
export const acceptsLegacyPeerOidc = (
  env: Record<string, string | undefined> = process.env
) => env.BUSY_LEGACY_PEER_OIDC !== "off";

const REFRESH_MARGIN_MS = 60_000;
interface Cached {
  expiresAt: number;
  token: Promise<string>;
}
// Process cache keyed by the consulted bot, not ctx.memo: eve rebuilds a child's credentials
// from the memos it opened with, so nothing time-keyed may enter a memo (docs/acceptance.md).
const cache = new Map<string, Cached>();

async function mint(
  toBotId: string,
  fetcher: HubFetch
): Promise<{ expiresAt: number; token: string }> {
  const res = await fetcher("/api/bot/consultations/credential", {
    body: JSON.stringify({ to: toBotId }),
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`hub refused the consultation credential: ${res.status}`);
  }
  const body = (await res.json()) as { expiresAt?: unknown; token?: unknown };
  if (
    typeof body.token !== "string" ||
    !body.token ||
    typeof body.expiresAt !== "number"
  ) {
    throw new Error("hub returned an invalid consultation credential");
  }
  return { expiresAt: body.expiresAt, token: body.token };
}

/**
 * eve's outbound auth for a remote peer: runs before every request to it (create, follow-up,
 * cancel, end, stream relay), so a durable follow-up after a runtime rebuild or a rotation just
 * gets a fresh credential. The token is never stored in facts, memos or logs.
 */
export function consultationAuth(
  toBotId: string,
  fetcher: HubFetch = hubFetch,
  now: () => number = Date.now
): OutboundAuthFn {
  return async () => {
    let entry = cache.get(toBotId);
    if (!entry || entry.expiresAt - REFRESH_MARGIN_MS <= now()) {
      const minted = mint(toBotId, fetcher);
      const pending: Cached = {
        expiresAt: Number.POSITIVE_INFINITY,
        token: minted.then(({ token }) => token),
      };
      cache.set(toBotId, pending);
      minted.then(
        ({ expiresAt }) => {
          pending.expiresAt = expiresAt;
        },
        () => {
          if (cache.get(toBotId) === pending) {
            cache.delete(toBotId);
          }
        }
      );
      entry = pending;
    }
    return { headers: { authorization: `Bearer ${await entry.token}` } };
  };
}

/** Tests only. */
export function clearConsultationCredentialCache() {
  cache.clear();
}
