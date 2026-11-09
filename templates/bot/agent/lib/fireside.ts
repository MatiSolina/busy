import { getVercelOidcToken } from "@vercel/oidc";
import { createGateway } from "ai";
import { hubFetch } from "./hub";
import { subscriptionModel } from "./subscription-model";

interface SessionContext {
  session: {
    id: string;
    parent?: { rootSessionId?: string };
    auth?: {
      current?: { principalId?: string } | null;
      initiator?: { principalId?: string } | null;
    } | null;
  };
}
const PRINCIPAL =
  /^busy-hub:hub:fireside:(?<fireside>[a-f0-9-]{36}):(?<participant>[a-f0-9-]{36}):(?<proof>[a-f0-9]{64})$/u;
export function firesideIdentity(ctx: SessionContext) {
  const principal =
    ctx.session.auth?.current?.principalId ??
    ctx.session.auth?.initiator?.principalId ??
    "";
  const match = PRINCIPAL.exec(principal)?.groups;
  return match
    ? {
        firesideId: match.fireside,
        participantId: match.participant,
        proof: match.proof,
        sessionId: ctx.session.parent?.rootSessionId ?? ctx.session.id,
      }
    : null;
}
export function firesideHeaders(
  identity: NonNullable<ReturnType<typeof firesideIdentity>>
) {
  return {
    "x-busy-fireside-id": identity.firesideId,
    "x-busy-fireside-participant": identity.participantId,
    "x-busy-fireside-proof": identity.proof,
    "x-busy-fireside-session": identity.sessionId,
  };
}
export interface FiresideProfile {
  billing: "gateway" | "token-pass" | "chatgpt" | "grok";
  model: string;
  name: string;
  workspace: string;
}
export async function firesideProfile(
  ctx: SessionContext
): Promise<FiresideProfile | null> {
  const identity = firesideIdentity(ctx);
  if (!identity) {
    return null;
  }
  const response = await hubFetch("/api/bot/firesides/profile", {
    headers: firesideHeaders(identity),
  });
  if (!response.ok) {
    throw new Error("The fireside is no longer available.");
  }
  return response.json() as Promise<FiresideProfile>;
}
export function firesideModel(profile: FiresideProfile, ctx: SessionContext) {
  const identity = firesideIdentity(ctx);
  if (!identity) {
    throw new Error("Missing fireside identity.");
  }
  const headers = firesideHeaders(identity);
  if (profile.billing === "chatgpt" || profile.billing === "grok") {
    return subscriptionModel(
      profile.billing,
      profile.model,
      ctx.session.id,
      headers
    );
  }
  return createGateway({
    apiKey: "busy-fireside-runtime",
    baseURL: `${process.env.HUB_URL}/api/bot/firesides/gateway`,
    fetch: async (input, init) => {
      const forwarded = new Headers(init?.headers);
      for (const [key, value] of Object.entries(headers)) {
        forwarded.set(key, value);
      }
      forwarded.set("authorization", `Bearer ${await getVercelOidcToken()}`);
      return fetch(input, { ...init, headers: forwarded });
    },
  })(profile.model);
}
