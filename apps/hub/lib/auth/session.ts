import { jwtVerify, SignJWT } from "jose";

export const SESSION_COOKIE = "busy_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;
// Shared by the password and Vercel logins so both mint the same cookie.
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: SESSION_MAX_AGE,
  path: "/",
  sameSite: "lax",
  secure: true,
} as const;

const key = (secret: string) => new TextEncoder().encode(secret);

export async function createSession(
  user: string,
  secret: string
): Promise<string> {
  return await new SignJWT({ user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(key(secret));
}

export async function readSession(
  token: string | undefined,
  secret: string
): Promise<{ user: string } | null> {
  if (!token) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ["HS256"],
    });
    return typeof payload.user === "string" ? { user: payload.user } : null;
  } catch {
    return null;
  }
}

// Bots and cron authenticate themselves (OIDC, CRON_SECRET); the relay checks hub OIDC.
const PUBLIC = [
  /^\/login$/u,
  /^\/install$/u,
  /^\/auth\/callback$/u,
  /^\/api\/download(?:\/version)?$/u,
  /^\/api\/(?:auth|bot|cron|dev)\//u,
  /^\/\.well-known\/busy-mcp-client$/u,
  /^\/mcp-app-sandbox$/u,
];

export const isPublicPath = (path: string) =>
  PUBLIC.some((re) => re.test(path));

/** A write the browser sent from another site (even *.matisolina.com): SameSite=Lax alone would let it through. */
export function crossSiteWrite(
  method: string,
  origin: string | null,
  host: string | null
): boolean {
  if (method === "GET" || method === "HEAD" || !origin) {
    return false;
  }
  return URL.parse(origin)?.host !== host;
}
