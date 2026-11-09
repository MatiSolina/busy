import { createHash, timingSafeEqual } from "node:crypto";
import { verifyHubRequest } from "./oidc";

type Env = Record<string, string | undefined>;

const TEAM = "mati-solina";
const SHA256_HEX = /^[0-9a-f]{64}$/iu;
// biome-ignore lint/style/useNamedCaptureGroup: This token regex targets an ES2017 TypeScript build and uses the stable numeric capture.
const BEARER_TOKEN = /^Bearer ([^\s]+)$/u;

function denied(status: 401 | 404): Response {
  return new Response(status === 404 ? "not found" : "unauthorized", {
    status,
  });
}

function bearer(req: Request): string | null {
  const value = req.headers.get("authorization");
  const match = value?.match(BEARER_TOKEN);
  return match?.[1] ?? null;
}

/**
 * Guard the local development relay with an explicitly bounded, token-specific grant.
 * Production remains closed because the gate requires DEV_RELAY=1 and a future expiry.
 */
export async function authorizeDevRelay(
  req: Request,
  env: Env = process.env,
  now = Date.now()
): Promise<Response | null> {
  if (env.DEV_RELAY !== "1") {
    return denied(404);
  }

  const until = Date.parse(env.DEV_RELAY_UNTIL ?? "");
  const expected = env.DEV_RELAY_TOKEN_SHA256 ?? "";
  if (!Number.isFinite(until) || until <= now || !SHA256_HEX.test(expected)) {
    return denied(404);
  }

  const token = bearer(req);
  if (!token) {
    return denied(401);
  }
  const actual = createHash("sha256").update(token).digest();
  const configured = Buffer.from(expected, "hex");
  if (
    configured.length !== actual.length ||
    !timingSafeEqual(configured, actual)
  ) {
    return denied(401);
  }

  try {
    await verifyHubRequest(req, { team: env.VERCEL_TEAM_SLUG ?? TEAM });
  } catch {
    return denied(401);
  }
  return null;
}
