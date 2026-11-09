import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/next-path";
import {
  authorizeUrl,
  callbackUrl,
  FLOW_COOKIE,
  FLOW_MAX_AGE,
  FLOW_PATH,
  newFlow,
  redirectTo,
  sealFlow,
  vercelLoginEnabled,
} from "@/lib/auth/vercel";
import { need } from "@/lib/env";

// Starts Sign in with Vercel: remember state/nonce/verifier/next, then send the browser to Vercel.
export async function GET(req: NextRequest) {
  const { origin, searchParams } = req.nextUrl;
  if (!vercelLoginEnabled()) {
    return redirectTo("/login");
  }

  const flow = newFlow(safeNext(searchParams.get("next"), origin));
  (await cookies()).set(
    FLOW_COOKIE,
    await sealFlow(flow, need("SESSION_SECRET")),
    {
      httpOnly: true,
      maxAge: FLOW_MAX_AGE,
      path: FLOW_PATH,
      // Lax: the callback is a top-level GET from vercel.com, which still carries it.
      sameSite: "lax",
      secure: true,
    }
  );
  return redirectTo(
    authorizeUrl(flow, need("VERCEL_APP_CLIENT_ID"), callbackUrl(origin))
  );
}
