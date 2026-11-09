import { existsSync } from "node:fs";

/**
 * Provider-backed evals must not turn a developer's unauthenticated local
 * `eve eval` run into a false product regression. Remote runs can still use a
 * linked Vercel project; no secret value is ever read or logged here.
 */
export function providerAuthAvailable(): boolean {
  if (process.env.AI_GATEWAY_API_KEY || process.env.EVE_EVAL_AUTH_TOKEN) {
    return true;
  }
  const oidc = process.env.VERCEL_OIDC_TOKEN;
  if (oidc) {
    try {
      const [, encoded] = oidc.split(".");
      if (encoded) {
        const claims = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8")
        ) as { exp?: unknown };
        if (typeof claims.exp === "number" && claims.exp * 1000 > Date.now()) {
          return true;
        }
      }
    } catch {
      // Treat an unreadable token as unavailable; never print or echo it.
    }
  }
  return existsSync(".vercel/project.json");
}
