import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getBot } from "@/lib/bots/service";
import { catalogEntry } from "@/lib/mcp/catalog";
import {
  connectionId,
  flowCookie,
  flowCookieOptions,
  resultPath,
} from "@/lib/mcp/http";
import {
  ConnectIntentMismatchError,
  consumeConnectIntent,
} from "@/lib/mcp/intent";
import { McpOAuthProvider, startOAuth } from "@/lib/mcp/oauth";
import { getProviderClient } from "@/lib/mcp/provider-clients";
import { registeredHubOrigin } from "@/lib/mcp/provider-origin";
import {
  registeredCallbackUrl,
  startRegisteredOAuth,
  startVercelCimdOAuth,
  vercelCimdCallbackUrl,
} from "@/lib/mcp/registered-oauth";
import { withConnection } from "@/lib/mcp/store";

export const maxDuration = 60;
type ConsentFlow = { url: string; state: string; cookiePath: string } | null;

// Roll back the row transaction for a stale connect URL while retaining the
// idempotent response for an already-connected row.
class AlreadyConnectedError extends Error {
  constructor() {
    super("MCP connection is already connected");
    this.name = "AlreadyConnectedError";
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const { slug, id } = await params;
  const ticket = new URL(req.url).searchParams.get("ticket");
  const { origin } = new URL(req.url);
  const fail = () =>
    NextResponse.redirect(new URL(resultPath(slug, "error"), origin), {
      headers: { "Cache-Control": "no-store" },
      status: 303,
    });
  const bot = await getBot(slug);
  if (!(bot && connectionId.safeParse(id).success)) {
    return fail();
  }
  try {
    const flow = await withConnection<ConsentFlow>(
      id,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this transaction serializes the existing bot OAuth reconnect branches and the CIMD exception.
      async (row, previous) => {
        const entry = catalogEntry(row.catalogId);
        if (entry?.auth !== "oauth") {
          throw new ConnectIntentMismatchError();
        }
        if (entry.oauthProvider) {
          registeredHubOrigin(origin);
        }
        if (row.status === "connected") {
          throw new AlreadyConnectedError();
        }
        const consumed = consumeConnectIntent(previous, ticket);
        if (!consumed) {
          throw new ConnectIntentMismatchError();
        }
        // Always start fresh consent on reconnect; never attach an old grant to a new account.
        const data = consumed.redirectOrigin === origin ? { ...consumed } : {};
        // biome-ignore lint/performance/noDelete: OAuth cleanup removes encrypted transient credentials before persistence.
        delete data.tokens;
        // biome-ignore lint/performance/noDelete: OAuth cleanup removes encrypted transient credentials before persistence.
        delete data.tokensIssuedAt;
        // biome-ignore lint/performance/noDelete: OAuth cleanup removes encrypted transient credentials before persistence.
        delete data.state;
        // biome-ignore lint/performance/noDelete: OAuth cleanup removes encrypted transient credentials before persistence.
        delete data.codeVerifier;
        // biome-ignore lint/performance/noDelete: OAuth cleanup removes encrypted transient credentials before persistence.
        delete data.flowStartedAt;
        data.redirectOrigin = origin;
        const provider = new McpOAuthProvider(data, {
          connectionId: id,
          origin,
          ...(entry.oauthClientMode === "cimd"
            ? { redirectUrl: vercelCimdCallbackUrl(origin) }
            : {}),
          scope: entry.oauthScopes,
        });
        try {
          if (entry.oauthClientMode === "cimd") {
            registeredHubOrigin(origin);
            const { authorizationUrl, state } = await startVercelCimdOAuth(
              provider,
              entry.url,
              { scope: entry.oauthScopes }
            );
            return {
              data: provider.data,
              error: null,
              status: "pending",
              value: {
                cookiePath: new URL(vercelCimdCallbackUrl(origin)).pathname,
                state,
                url: authorizationUrl.href,
              },
            };
          }
          if (entry.oauthProvider) {
            const client = await getProviderClient(entry.oauthProvider);
            if (!client) {
              throw new Error("OAuth client is not configured");
            }
            const { authorizationUrl, state } = startRegisteredOAuth(
              provider,
              entry.oauthProvider,
              client,
              { scope: entry.oauthScopes }
            );
            return {
              data: provider.data,
              error: null,
              status: "pending",
              value: {
                cookiePath: new URL(
                  registeredCallbackUrl(origin, entry.oauthProvider)
                ).pathname,
                state,
                url: authorizationUrl.href,
              },
            };
          }
          const { authorizationUrl, result } = await startOAuth(
            provider,
            entry.url,
            { scope: entry.oauthScopes }
          );
          if (
            result !== "REDIRECT" ||
            !authorizationUrl ||
            !provider.data.state
          ) {
            throw new Error("Missing OAuth challenge");
          }
          return {
            data: provider.data,
            error: null,
            status: "pending",
            value: {
              cookiePath: flowCookieOptions.path,
              state: provider.data.state,
              url: authorizationUrl.href,
            },
          };
        } catch {
          provider.invalidateCredentials("verifier");
          return {
            data: provider.data,
            error: "Couldn't start sign-in. Try reconnecting.",
            status: "error",
            value: null,
          };
        }
      }
    );
    if (!flow) {
      return fail();
    }
    const jar = await cookies();
    jar.set(flowCookie(id), flow.state, {
      ...flowCookieOptions,
      path: flow.cookiePath,
    });
    return NextResponse.redirect(flow.url, {
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
      status: 303,
    });
  } catch (error) {
    if (error instanceof AlreadyConnectedError) {
      return NextResponse.redirect(
        new URL(resultPath(slug, "connected"), origin),
        { status: 303 }
      );
    }
    return fail();
  }
}
