import { importJWK, type JWK, SignJWT } from "jose";
import { need } from "./env";

// Hub → bot bearer. The hub's Vercel OIDC token was valid on every bot, so a bot that got one
// could replay it on the others. This token names one bot (aud = its slug) and lasts 5 minutes.
// Bots check it with eve's jwtEcdsa() and HUB_PUBLIC_KEY (templates/bot/agent/channels/eve.ts).
export const HUB_ISSUER = "busy-hub";
const TTL = "5m";

let imported: { raw: string; key: ReturnType<typeof importJWK> } | undefined;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Routine run ids are database UUIDs and become part of a short-lived JWT subject. */
export function isRoutineRunId(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

async function signHubSubject(
  slug: string,
  subject: string,
  raw: string
): Promise<string> {
  if (imported?.raw !== raw) {
    imported = { key: importJWK(JSON.parse(raw) as JWK, "ES256"), raw };
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(HUB_ISSUER)
    .setSubject(subject)
    .setAudience(slug)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(await imported.key);
}

/** HUB_SIGNING_KEY: the private ES256 JWK as one line of JSON (scripts/gen-hub-key.ts). */
export async function signHubToken(
  slug: string,
  raw = need("HUB_SIGNING_KEY")
): Promise<string> {
  // Not a `project:bot-*` subject, so bots never treat the hub as a consultation (agent/lib/caller.ts).
  return await signHubSubject(slug, "hub", raw);
}

/**
 * A routine gets its own service principal while it is delivered to the bot's
 * existing session. Eve uses the distinct principal to keep a queued routine
 * separate from the user's messages and from pending human input.
 */
export async function signRoutineToken(
  slug: string,
  runId: string,
  raw = need("HUB_SIGNING_KEY")
): Promise<string> {
  if (!isRoutineRunId(runId)) {
    throw new Error("Routine run id must be a UUID.");
  }
  return await signHubSubject(slug, `hub:routine:${runId.toLowerCase()}`, raw);
}

/** Completion is queued as a distinct service identity, never as the human replying to a prompt. */
export async function signCodeTaskToken(
  slug: string,
  taskId: string,
  raw = need("HUB_SIGNING_KEY")
): Promise<string> {
  if (!isRoutineRunId(taskId)) {
    throw new Error("Code task id must be a UUID.");
  }
  return await signHubSubject(
    slug,
    `hub:code-task:${taskId.toLowerCase()}`,
    raw
  );
}

/** Full fireside sessions have a private proof, distinct from read-only peer consultations. */
const FIRESIDE_PROOF = /^[a-f0-9]{64}$/u;
export function signFiresideToken(
  slug: string,
  firesideId: string,
  participantId: string,
  proof: string,
  raw = need("HUB_SIGNING_KEY")
) {
  if (
    !(
      isRoutineRunId(firesideId) &&
      isRoutineRunId(participantId) &&
      FIRESIDE_PROOF.test(proof)
    )
  ) {
    throw new Error("Invalid fireside identity.");
  }
  return signHubSubject(
    slug,
    `hub:fireside:${firesideId}:${participantId}:${proof}`,
    raw
  );
}

/**
 * Consultation credential (H-26): one asking bot → one consulted bot, for one purpose.
 * Its own audience namespace (`busy-consultation:<slug>`), never the bare slug, so the consulted
 * bot's hub verifier (aud = slug) refuses it, another bot refuses it (other slug), and the hub's
 * /api/bot/* refuses it (Vercel OIDC issuer only). The asking bot never holds the private key and
 * never chooses issuer, subject or claims: the hub fills them from its authenticated identity.
 * The subject names both ids (`consultation:<from>:<to>`): eve records it as the child's admitted
 * principal, which is how the hub's sync learns the dispatched target (lib/chat/peer-binding.ts).
 * H-08 hook: when bot identity moves from slug to an immutable id, version the audience here and
 * in templates/bot/agent/lib/consultation-auth.ts together.
 */
export const CONSULTATION_AUDIENCE_PREFIX = "busy-consultation:";
export const CONSULTATION_SUBJECT_PREFIX = "consultation:";
export const CONSULTATION_PURPOSE = "consultation";
const CONSULTATION_TTL_SECONDS = 5 * 60;

export interface ConsultationCredential {
  credentialId: string;
  expiresAt: number;
  token: string;
}

export async function signConsultationToken(
  from: { id: string; slug: string },
  to: { id: string; slug: string },
  raw = need("HUB_SIGNING_KEY"),
  now = Date.now()
): Promise<ConsultationCredential> {
  if (
    !(isRoutineRunId(from.id) && isRoutineRunId(to.id)) ||
    from.id === to.id
  ) {
    throw new Error("A consultation needs two distinct bot ids.");
  }
  if (imported?.raw !== raw) {
    imported = { key: importJWK(JSON.parse(raw) as JWK, "ES256"), raw };
  }
  const credentialId = crypto.randomUUID();
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + CONSULTATION_TTL_SECONDS;
  const token = await new SignJWT({
    busy_purpose: CONSULTATION_PURPOSE,
    from_bot: from.id,
    from_slug: from.slug,
    to_bot: to.id,
  })
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer(HUB_ISSUER)
    .setSubject(`${CONSULTATION_SUBJECT_PREFIX}${from.id}:${to.id}`)
    .setAudience(`${CONSULTATION_AUDIENCE_PREFIX}${to.slug}`)
    .setJti(credentialId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(await imported.key);
  return { credentialId, expiresAt: expiresAt * 1000, token };
}

/** The public half of HUB_SIGNING_KEY, set on every bot project as HUB_PUBLIC_KEY. */
export function hubPublicKey(raw = need("HUB_SIGNING_KEY")): string {
  const { kty, crv, x, y } = JSON.parse(raw) as JWK;
  return JSON.stringify({ crv, kty, x, y });
}
