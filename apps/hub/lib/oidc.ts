import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

const BOT_SUBJECT =
  // biome-ignore lint/style/useNamedCaptureGroup: OIDC claims target an ES2017 TypeScript build and use stable numeric captures.
  /^owner:([^:]+):project:bot-([a-z0-9-]+):environment:production$/u;
const HUB_SUBJECT =
  // biome-ignore lint/style/useNamedCaptureGroup: OIDC claims target an ES2017 TypeScript build and use stable numeric captures.
  /^owner:([^:]+):project:busy-hub:environment:(production|preview|development)$/u;
const BEARER_PREFIX = /^Bearer /u;

export function botSlugFromSubject(sub: string, team: string): string | null {
  const m = BOT_SUBJECT.exec(sub);
  return m && m[1] === team ? m[2] : null;
}

export function isHubSubject(sub: string, team: string): boolean {
  const m = HUB_SUBJECT.exec(sub);
  return m?.[1] === team;
}

const remote = new Map<string, JWTVerifyGetKey>();
const jwksFor = (team: string) => {
  let set = remote.get(team);
  if (!set) {
    set = createRemoteJWKSet(
      new URL(`https://oidc.vercel.com/${team}/.well-known/jwks`)
    );
    remote.set(team, set);
  }
  return set;
};

async function verifiedClaims(
  req: Request,
  opts: { team: string; jwks?: JWTVerifyGetKey }
): Promise<{ environment: unknown; projectId: unknown; sub: string }> {
  const token = req.headers.get("authorization")?.replace(BEARER_PREFIX, "");
  if (!token) {
    throw new Error("missing bearer token");
  }
  const { payload } = await jwtVerify(token, opts.jwks ?? jwksFor(opts.team), {
    audience: `https://vercel.com/${opts.team}`,
    issuer: `https://oidc.vercel.com/${opts.team}`,
  });
  // Claim names as in @vercel/oidc's VercelOidcPayload.
  return {
    environment: payload.environment,
    projectId: payload.project_id,
    sub: payload.sub ?? "",
  };
}

async function verifiedSubject(
  req: Request,
  opts: { team: string; jwks?: JWTVerifyGetKey }
): Promise<string> {
  return (await verifiedClaims(req, opts)).sub;
}

/** Someone holding a busy-hub OIDC token: the hub itself or a team member's `vercel env pull`. */
export async function verifyHubRequest(
  req: Request,
  opts: { team: string; jwks?: JWTVerifyGetKey }
): Promise<void> {
  if (!isHubSubject(await verifiedSubject(req, opts), opts.team)) {
    throw new Error("caller is not the hub");
  }
}

/**
 * A production deployment of a bot project of the team, calling the hub with its Vercel OIDC token.
 * Throws when it isn't one. `projectId` is the stable identity (lib/bot-auth.ts checks it against
 * the bot row); the slug from the subject is only the label the row must still carry.
 */
export async function verifyBotRequest(
  req: Request,
  opts: { team: string; jwks?: JWTVerifyGetKey }
): Promise<{ projectId: string; slug: string }> {
  const claims = await verifiedClaims(req, opts);
  const slug = botSlugFromSubject(claims.sub, opts.team);
  if (!slug) {
    throw new Error("caller is not a bot of this team");
  }
  if (claims.environment !== "production") {
    throw new Error("caller is not a production deployment");
  }
  if (typeof claims.projectId !== "string" || !claims.projectId) {
    throw new Error("caller has no project id");
  }
  return { projectId: claims.projectId, slug };
}
