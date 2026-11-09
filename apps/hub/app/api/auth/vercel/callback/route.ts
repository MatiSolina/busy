import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { safeNext } from "@/lib/auth/next-path";
import {
  createSession,
  SESSION_COOKIE,
  SESSION_COOKIE_OPTIONS,
} from "@/lib/auth/session";
import {
  allowedVercelUser,
  callbackUrl,
  exchangeCode,
  FLOW_COOKIE,
  FLOW_PATH,
  openFlow,
  redirectTo,
  vercelLoginEnabled,
  verifyIdToken,
} from "@/lib/auth/vercel";
import { need } from "@/lib/env";

// Vercel sends the browser back here with ?code&state (or ?error&state when the user cancels).
export async function GET(req: NextRequest) {
  const { origin, searchParams } = req.nextUrl;
  const jar = await cookies();
  const secret = need("SESSION_SECRET");
  const flow = await openFlow(jar.get(FLOW_COOKIE)?.value, secret);
  // One use per flow: a replayed callback finds no cookie.
  jar.delete({ name: FLOW_COOKIE, path: FLOW_PATH });

  const fail = (why: string) => {
    console.warn(`Sign in with Vercel refused: ${why}`);
    const params = new URLSearchParams({ error: "vercel" });
    if (flow && flow.next !== "/") {
      params.set("next", flow.next);
    }
    return redirectTo(`/login?${params}`);
  };

  if (!vercelLoginEnabled()) {
    return fail("not configured");
  }
  if (!flow || searchParams.get("state") !== flow.state) {
    return fail("missing or mismatched state");
  }
  const code = searchParams.get("code");
  if (!code) {
    return fail(searchParams.get("error") ?? "no code");
  }

  try {
    const clientId = need("VERCEL_APP_CLIENT_ID");
    const idToken = await exchangeCode(code, flow, {
      clientId,
      clientSecret: need("VERCEL_APP_CLIENT_SECRET"),
      redirectUri: callbackUrl(origin),
    });
    const sub = await verifyIdToken(idToken, { clientId, nonce: flow.nonce });
    // Logging the id is what lets the owner copy it into BUSY_VERCEL_USERS.
    if (!allowedVercelUser(sub, process.env.BUSY_VERCEL_USERS)) {
      return fail(`Vercel user ${sub} is not in BUSY_VERCEL_USERS`);
    }
    jar.set(
      SESSION_COOKIE,
      await createSession(`vercel:${sub}`, secret),
      SESSION_COOKIE_OPTIONS
    );
    return redirectTo(safeNext(flow.next, origin));
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
