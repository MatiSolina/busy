import { createHash, randomBytes } from "node:crypto";
import {
  createRemoteJWKSet,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";

// Sign in with Vercel: OAuth 2.0 authorization code + PKCE + OIDC (https://vercel.com/docs/sign-in-with-vercel).
const ISSUER = "https://vercel.com";
const AUTHORIZE_URL = "https://vercel.com/oauth/authorize";
const TOKEN_URL = "https://api.vercel.com/login/oauth/token";
const jwks = createRemoteJWKSet(new URL("https://vercel.com/.well-known/jwks"));

export const FLOW_COOKIE = "busy_vercel_flow";
export const FLOW_PATH = "/api/auth/vercel";
export const FLOW_MAX_AGE = 60 * 10;
const FLOW_AUD = "busy:vercel-flow";

type Source = Record<string, string | undefined>;

/** Without the app credentials and an allowlist the button stays hidden and only the password login exists. */
export const vercelLoginEnabled = (env: Source = process.env) =>
  Boolean(
    env.VERCEL_APP_CLIENT_ID &&
      env.VERCEL_APP_CLIENT_SECRET &&
      env.BUSY_VERCEL_USERS
  );

/** BUSY_VERCEL_USERS lists Vercel user ids (the ID token `sub`): stable, unlike username or email. */
export function allowedVercelUser(
  sub: string,
  list: string | undefined
): boolean {
  return (
    Boolean(sub) && (list ?? "").split(",").some((id) => id.trim() === sub)
  );
}

/**
 * Must equal a callback URL registered on the Vercel app. Built from HUB_URL because behind a proxy
 * (portless locally) the request origin is the internal one; the request origin is only a fallback.
 */
export function callbackUrl(
  requestOrigin: string,
  env: Source = process.env
): string {
  return `${env.HUB_URL ? new URL(env.HUB_URL).origin : requestOrigin}${FLOW_PATH}/callback`;
}

/** A relative Location keeps the browser on whatever host it came in on. */
export const redirectTo = (path: string) =>
  new Response(null, { headers: { Location: path }, status: 307 });

export interface Flow {
  next: string;
  nonce: string;
  state: string;
  verifier: string;
}

const random = () => randomBytes(32).toString("base64url");
export const newFlow = (next: string): Flow => ({
  next,
  nonce: random(),
  state: random(),
  verifier: random(),
});

/** RFC 7636 S256, the only method Vercel accepts. */
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

export function authorizeUrl(
  flow: Flow,
  clientId: string,
  redirectUri: string
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    code_challenge: pkceChallenge(flow.verifier),
    code_challenge_method: "S256",
    nonce: flow.nonce,
    redirect_uri: redirectUri,
    response_type: "code",
    // Only identity: the allowlist needs `sub`, nothing else.
    scope: "openid",
    state: flow.state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

const key = (secret: string) => new TextEncoder().encode(secret);

// The flow rides in a short-lived signed cookie, so any instance can finish it and a cookie tossed in
// from a sibling subdomain can't pose as one.
export async function sealFlow(flow: Flow, secret: string): Promise<string> {
  return await new SignJWT({ ...flow })
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(FLOW_AUD)
    .setExpirationTime(`${FLOW_MAX_AGE}s`)
    .sign(key(secret));
}

export async function openFlow(
  token: string | undefined,
  secret: string
): Promise<Flow | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload: p } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
      audience: FLOW_AUD,
    });
    const { state, nonce, verifier, next } = p;
    if (
      typeof state !== "string" ||
      typeof nonce !== "string" ||
      typeof verifier !== "string" ||
      typeof next !== "string"
    ) {
      return null;
    }
    return { next, nonce, state, verifier };
  } catch {
    return null;
  }
}

/** Swaps the code for tokens (client_secret_post). Only the ID token is used; the access token is dropped. */
export async function exchangeCode(
  code: string,
  flow: Flow,
  opts: { clientId: string; clientSecret: string; redirectUri: string }
): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    body: new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      code,
      code_verifier: flow.verifier,
      grant_type: "authorization_code",
      redirect_uri: opts.redirectUri,
    }),
    method: "POST",
  });
  const body = (await res.json().catch(() => ({}))) as {
    id_token?: string;
    error?: string;
  };
  if (!(res.ok && body.id_token)) {
    throw new Error(`token exchange failed: ${res.status} ${body.error ?? ""}`);
  }
  // ponytail: the 1 h access token is never stored, so it isn't revoked either.
  return body.id_token;
}

/** Verifies the ID token against Vercel's JWKS and this flow's nonce; returns the Vercel user id. */
export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonce: string; jwks?: JWTVerifyGetKey }
): Promise<string> {
  const { payload } = await jwtVerify(idToken, opts.jwks ?? jwks, {
    algorithms: ["RS256"],
    audience: opts.clientId,
    issuer: ISSUER,
  });
  // The nonce ties the token to the sign-in this browser started; a replayed token carries another one.
  if (payload.nonce !== opts.nonce) {
    throw new Error("id token nonce mismatch");
  }
  if (!payload.sub) {
    throw new Error("id token has no sub");
  }
  return payload.sub;
}
