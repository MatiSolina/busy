type Source = Record<string, string | undefined>;

export type EnvKey =
  | "HUB_URL"
  | "VERCEL_TOKEN"
  | "VERCEL_TEAM_ID"
  | "VERCEL_TEAM_SLUG"
  | "BOTS_DOMAIN"
  | "BUSY_USER"
  | "BUSY_PASSWORD_HASH"
  | "VERCEL_APP_CLIENT_ID"
  | "VERCEL_APP_CLIENT_SECRET"
  | "SESSION_SECRET"
  | "DATABASE_URL"
  | "CRON_SECRET"
  | "BOT_BASE_IMAGE"
  | "TOKEN_PASS_API_KEY"
  | "HUB_SIGNING_KEY";

// Read each variable where it's used, so a route only fails for what it needs.
export function need(key: EnvKey, source: Source = process.env): string {
  const value = source[key];
  if (!value) {
    throw new Error(`Missing environment variable ${key}`);
  }
  return value;
}
