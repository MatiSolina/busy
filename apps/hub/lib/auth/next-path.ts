// Client-safe: imported by the login page, so it must not pull in jose.
/** Where to go after login: only a path on this origin, never `//host` or `/\host`. */
export function safeNext(next: string | null, origin: string): string {
  if (
    !next?.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\")
  ) {
    return "/";
  }
  try {
    const u = new URL(next, origin);
    const path = u.pathname + u.search + u.hash;
    // Dot segments can collapse into `//host` ("/.//evil.com" → "//evil.com"), which the browser
    // reads as another origin: check the normalized path, not only the input.
    return u.origin === origin && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}
