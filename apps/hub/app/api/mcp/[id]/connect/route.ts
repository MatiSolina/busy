import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { catalogEntry } from "@/lib/mcp/catalog";
import {
  connectionId,
  contextualResultPath,
  flowCookie,
  flowCookieOptions,
  mcpJson,
  resultPath,
  safeReturnTo,
} from "@/lib/mcp/http";
import {
  ConnectIntentMismatchError,
  consumeConnectIntent,
  createConnectIntent,
} from "@/lib/mcp/intent";
import { McpOAuthProvider, type OAuthData, startOAuth } from "@/lib/mcp/oauth";
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

function resetConsentData(
  data: OAuthData,
  origin: string,
  returnTo: string | null
): OAuthData {
  return {
    ...data,
    codeVerifier: undefined,
    flowStartedAt: undefined,
    redirectOrigin: origin,
    returnTo: returnTo ?? undefined,
    state: undefined,
    tokens: undefined,
    tokensIssuedAt: undefined,
  };
}

async function beginOAuth(
  entry: ReturnType<typeof catalogEntry>,
  provider: McpOAuthProvider,
  origin: string
): Promise<ConsentFlow> {
  if (entry?.auth !== "oauth") {
    throw new ConnectIntentMismatchError();
  }
  try {
    if (entry.oauthClientMode === "cimd") {
      registeredHubOrigin(origin);
      const { authorizationUrl, state } = await startVercelCimdOAuth(
        provider,
        entry.url,
        { scope: entry.oauthScopes }
      );
      return {
        cookiePath: new URL(vercelCimdCallbackUrl(origin)).pathname,
        state,
        url: authorizationUrl.href,
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
        cookiePath: new URL(registeredCallbackUrl(origin, entry.oauthProvider))
          .pathname,
        state,
        url: authorizationUrl.href,
      };
    }
    const { authorizationUrl, result } = await startOAuth(provider, entry.url, {
      scope: entry.oauthScopes,
    });
    if (result !== "REDIRECT" || !authorizationUrl || !provider.data.state) {
      throw new Error("Missing OAuth challenge");
    }
    return {
      cookiePath: flowCookieOptions.path,
      state: provider.data.state,
      url: authorizationUrl.href,
    };
  } catch {
    provider.invalidateCredentials("verifier");
    return null;
  }
}

class AlreadyConnectedError extends Error {
  constructor() {
    super("MCP connection is already connected");
    this.name = "AlreadyConnectedError";
  }
}

class ReconnectUnavailableError extends Error {
  constructor() {
    super("GitHub reconnect is unavailable");
    this.name = "ReconnectUnavailableError";
  }
}

/** Prepare an explicit, one-use browser handoff without touching the grant yet. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  const { origin } = new URL(req.url);
  const intent = createConnectIntent();
  try {
    const connectUrl = await withConnection<string | null>(
      id,
      async (row, data) => {
        const entry = catalogEntry(row.catalogId);
        if (entry?.auth !== "oauth" || entry.oauthProvider !== "github") {
          throw new ConnectIntentMismatchError();
        }
        registeredHubOrigin(origin);
        const client = await getProviderClient("github");
        if (!client) {
          throw new ReconnectUnavailableError();
        }
        return {
          data: {
            ...data,
            codeVerifier: undefined,
            connectIntent: intent,
            flowStartedAt: undefined,
            returnTo: undefined,
            state: undefined,
          },
          error: null,
          status: "pending",
          value: `/api/mcp/${id}/connect?ticket=${encodeURIComponent(intent.token)}`,
        };
      }
    );
    if (!connectUrl) {
      return mcpJson({ error: "Connection not found." }, 404);
    }
    return mcpJson({ connectUrl });
  } catch (error) {
    if (error instanceof ReconnectUnavailableError) {
      return mcpJson(
        { error: "GitHub sign-in is not configured. Try again later." },
        409
      );
    }
    return mcpJson({ error: "Connection not found." }, 404);
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const requestUrl = new URL(req.url);
  const ticket = requestUrl.searchParams.get("ticket");
  const requestedReturnTo = requestUrl.searchParams.get("returnTo");
  const returnTo = safeReturnTo(requestedReturnTo);
  const { origin } = requestUrl;
  const fail = () =>
    NextResponse.redirect(
      new URL(
        contextualResultPath(returnTo, "error") ?? resultPath("", "error"),
        origin
      ),
      {
        headers: { "Cache-Control": "no-store" },
        status: 303,
      }
    );
  if (
    !connectionId.safeParse(id).success ||
    (requestedReturnTo !== null && !returnTo)
  ) {
    return fail();
  }
  try {
    const flow = await withConnection<ConsentFlow>(
      id,
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
        const data = resetConsentData(
          consumed.redirectOrigin === origin ? consumed : {},
          origin,
          returnTo
        );
        const provider = new McpOAuthProvider(data, {
          connectionId: id,
          origin,
          ...(entry.oauthClientMode === "cimd"
            ? { redirectUrl: vercelCimdCallbackUrl(origin) }
            : {}),
          scope: entry.oauthScopes,
        });
        const consent = await beginOAuth(entry, provider, origin);
        return {
          data: provider.data,
          error: consent ? null : "Couldn't start sign-in. Try reconnecting.",
          status: consent ? "pending" : "error",
          value: consent,
        };
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
        new URL(
          contextualResultPath(returnTo, "connected") ??
            resultPath("", "connected"),
          origin
        ),
        { status: 303 }
      );
    }
    return fail();
  }
}
