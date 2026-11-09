import { eq } from "drizzle-orm";
import { z } from "zod";
import { bots, db } from "../db";
import {
  type ConsultationCredential,
  signConsultationToken,
} from "../hub-token";
import { peerDirectory } from "./peer-binding";

export const consultationCredentialInput = z.object({
  to: z.uuid(),
});

export type ConsultationCredentialResult =
  | { credential: ConsultationCredential; ok: true; toBotId: string }
  | { error: string; ok: false; status: 403 | 404 };

/**
 * H-26: the hub mints a consultation credential for a bot it authenticated itself (Vercel OIDC,
 * `callerSlug`) and a destination it verifies: an existing, ready bot in the caller's current
 * peer window, never the caller. The body only names the destination id; issuer, subject,
 * audience and claims come from the hub. The bearer is returned, never stored or logged.
 * H-08 hook: `callerSlug` is today's verified identity; once OIDC resolves an immutable bot id,
 * look the caller up by it instead.
 */
export async function issueConsultationCredential(
  callerSlug: string,
  toBotId: string,
  sign: typeof signConsultationToken = signConsultationToken
): Promise<ConsultationCredentialResult> {
  const [from] = await db()
    .select({ id: bots.id, slug: bots.slug, status: bots.status })
    .from(bots)
    .where(eq(bots.slug, callerSlug));
  if (!from) {
    return { error: "Bot not found.", ok: false, status: 404 };
  }
  const { window } = await peerDirectory(from);
  const to = window.find((peer) => peer.id === toBotId);
  if (!to) {
    return {
      error: "That bot can't be consulted from this bot.",
      ok: false,
      status: 403,
    };
  }
  return {
    credential: await sign(from, to),
    ok: true,
    toBotId: to.id,
  };
}
