import { type NextRequest, NextResponse } from "next/server";
import {
  crossSiteWrite,
  isPublicPath,
  readSession,
  SESSION_COOKIE,
} from "@/lib/auth/session";

const DOCS = "https://busybot.dev/developers";

/** The gate's errors in the same JSON shape as the API's own (lib/ai/errors.ts issueResponse). */
export function gateError(status: 401 | 403) {
  const body =
    status === 401
      ? {
          action: "sign-in",
          code: "unauthorized",
          message:
            "Sign in first: POST /api/auth/login with {user, password}, then send the busy_session cookie it sets.",
        }
      : {
          action: null,
          code: "forbidden",
          message:
            "Writes sent from another site are refused. Send them from the hub's own origin.",
        };
  return Response.json(
    { ...body, docs: DOCS, error: body.code, retryable: false },
    { status }
  );
}

// Single-account gate (spec 4.8). Bots, cron and the dev relay authenticate on their own routes.
export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Before the public paths too, so another site can't post to login or logout. Behind a proxy (Vercel's
  // edge, portless locally) the public host is x-forwarded-host; a cross-site form can't set it.
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (crossSiteWrite(req.method, req.headers.get("origin"), host)) {
    return gateError(403);
  }
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return NextResponse.next();
  }

  const secret = process.env.SESSION_SECRET;
  const session = secret
    ? await readSession(req.cookies.get(SESSION_COOKIE)?.value, secret)
    : null;
  if (session) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return gateError(401);
  }
  const login = new URL("/login", req.url);
  if (pathname !== "/") {
    login.searchParams.set("next", pathname + req.nextUrl.search);
  }
  return NextResponse.redirect(login);
}

export const config = {
  // Only Next's own assets, file-based metadata assets, Workflow's internal routes, queue consumers
  // (Vercel Queues callbacks, verified by @vercel/queue) and the bots' own
  // API skip the gate: no path is public by its extension. Every /api/bot/ route authenticates its
  // caller's Vercel OIDC bearer token and reads no cookie, so it gains nothing here and paid a
  // middleware hop on each of a turn's hub calls (memory, directory, the model proxy).
  matcher: [
    "/((?!_next/static/|_next/image|favicon\\.ico|icon\\.svg$|apple-icon\\.png$|opengraph-image\\.png$|\\.well-known/workflow/|\\.well-known/durable-harness/v1/fx/?$|api/bot/|api/queues/).*)",
  ],
};
