// Brute-force guard for the password login. Counts live in Postgres so every serverless instance sees them.
export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_LIMITS = { perIp: 5, total: 30 };

/** Vercel overwrites x-forwarded-for with the real client IP, so a caller can't pick its own. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

/** Failures in the last window: one IP gets a few tries; the global cap stops guessing spread over many IPs. */
export function loginBlocked(
  failures: { ip: number; total: number },
  limits = LOGIN_LIMITS
): boolean {
  return failures.ip >= limits.perIp || failures.total >= limits.total;
}
