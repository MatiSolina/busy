import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { catalogEntry } from "@/lib/mcp/catalog";
import {
  connectionId,
  contextualResultPath,
  FLOW_MAX_AGE,
  FLOW_PATH,
  flowCookie,
  mcpJson,
  resultPath,
  safeReturnTo,
} from "@/lib/mcp/http";
import {
  finishOAuth,
  McpOAuthProvider,
  McpOAuthTransientError,
  McpReconnectError,
} from "@/lib/mcp/oauth";
import {
  logOAuthDiagnostic,
  type OAuthDiagnosticCategory,
} from "@/lib/mcp/oauth-diagnostics";
import { getProviderClient } from "@/lib/mcp/provider-clients";
import { registeredHubOrigin } from "@/lib/mcp/provider-origin";
import {
  finishRegisteredOAuth,
  finishVercelCimdOAuth,
  type RegisteredProvider,
  registeredCallbackUrl,
  registeredProviderDefinition,
  vercelCimdCallbackUrl,
} from "@/lib/mcp/registered-oauth";
import { withConnection } from "@/lib/mcp/store";

function matches(
  a: string | undefined | null,
  b: string | undefined | null
): boolean {
  if (!(a && b)) {
    return false;
  }
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function callbackProvider(
  registeredProvider?: RegisteredProvider,
  cimdProvider?: "vercel"
): "github" | "google" | "vercel" | "unknown" {
  return registeredProvider ?? cimdProvider ?? "unknown";
}

function callbackFailureCategory(error: unknown): OAuthDiagnosticCategory {
  if (error instanceof McpReconnectError) {
    return "reconnect_required";
  }
  if (error instanceof McpOAuthTransientError) {
    return "transient_failure";
  }
  return "exchange_failed";
}

export async function completeMcpCallback(
  req: Request,
  registeredProvider?: RegisteredProvider,
  cimdProvider?: "vercel"
) {
  const { origin, searchParams } = new URL(req.url);
  const providerKind = callbackProvider(registeredProvider, cimdProvider);
  if (registeredProvider || cimdProvider) {
    try {
      registeredHubOrigin(origin);
    } catch {
      logOAuthDiagnostic({
        category: "origin_rejected",
        provider: providerKind,
        stage: "callback",
      });
      return mcpJson(
        { error: "Open OAuth from the configured Busy hub." },
        400
      );
    }
  }
  const state = searchParams.get("state");
  const id =
    registeredProvider || cimdProvider
      ? state?.split(".")[0]
      : searchParams.get("cid");
  let cookiePath = FLOW_PATH;
  if (registeredProvider) {
    cookiePath = new URL(registeredCallbackUrl(origin, registeredProvider))
      .pathname;
  } else if (cimdProvider) {
    cookiePath = new URL(vercelCimdCallbackUrl(origin)).pathname;
  }
  const redirect = (
    returnTo: string | null = null,
    result: "connected" | "error" = "error"
  ) =>
    NextResponse.redirect(
      new URL(
        contextualResultPath(returnTo, result) ?? resultPath("", result),
        origin
      ),
      {
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
        status: 303,
      }
    );
  if (
    !(connectionId.safeParse(id).success && id) ||
    (state && state.length > 256)
  ) {
    logOAuthDiagnostic({
      category: "invalid_callback_state",
      provider: providerKind,
      stage: "callback",
    });
    return redirect();
  }
  const jar = await cookies();
  const browserState = jar.get(flowCookie(id))?.value;
  // A callback needs both the logged-in Hub session (proxy.ts) and this browser's OAuth flow.
  if (!matches(browserState, state)) {
    logOAuthDiagnostic({
      category: "browser_binding_mismatch",
      provider: providerKind,
      stage: "callback",
    });
    return redirect();
  }
  jar.delete({ name: flowCookie(id), path: cookiePath });
  try {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: OAuth callback validation intentionally keeps replay and provider checks in one locked flow.
    const outcome = await withConnection(id, async (row, data) => {
      const entry = catalogEntry(row.catalogId);
      const returnTo = safeReturnTo(data.returnTo);
      // Read/validate/consume the flow while holding the row lock: a replay cannot exchange twice.
      if (
        entry?.auth !== "oauth" ||
        (registeredProvider && entry.oauthProvider !== registeredProvider) ||
        (cimdProvider &&
          (entry.oauthClientMode !== "cimd" || entry.id !== "vercel")) ||
        row.status !== "pending" ||
        data.redirectOrigin !== origin ||
        !matches(data.state, state) ||
        !data.flowStartedAt ||
        Date.now() - data.flowStartedAt > FLOW_MAX_AGE * 1000
      ) {
        logOAuthDiagnostic({
          category: "flow_rejected",
          provider: providerKind,
          stage: "callback",
        });
        if (row.status === "pending" && matches(data.state, state)) {
          // biome-ignore lint/performance/noDelete: Callback completion removes one-use OAuth state before encrypting the row.
          delete data.state;
          // biome-ignore lint/performance/noDelete: Callback completion removes one-use PKCE state before encrypting the row.
          delete data.codeVerifier;
          // biome-ignore lint/performance/noDelete: Callback completion removes one-use OAuth state before encrypting the row.
          delete data.flowStartedAt;
          // biome-ignore lint/performance/noDelete: OAuth callback consumes the contextual return destination with the one-use state.
          delete data.returnTo;
          return {
            data,
            error: "Sign-in expired. Reconnect to try again.",
            status: "error",
            value: { result: "error" as const, returnTo },
          };
        }
        return { data, value: { result: "error" as const, returnTo: null } };
      }
      const oauthProvider = new McpOAuthProvider(data, {
        connectionId: id,
        origin,
        ...(cimdProvider ? { redirectUrl: vercelCimdCallbackUrl(origin) } : {}),
        scope: entry.oauthScopes,
      });
      let success = false;
      let exchangeStarted = false;
      let diagnosticLogged = false;
      try {
        const code = searchParams.get("code");
        if (searchParams.has("error")) {
          logOAuthDiagnostic({
            category: "provider_denied",
            provider: providerKind,
            stage: "callback",
          });
          diagnosticLogged = true;
          throw new Error("Consent not completed");
        }
        if (!code || code.length > 8192) {
          logOAuthDiagnostic({
            category: "missing_authorization_code",
            provider: providerKind,
            stage: "callback",
          });
          diagnosticLogged = true;
          throw new Error("Consent not completed");
        }
        if (!state) {
          logOAuthDiagnostic({
            category: "invalid_callback_state",
            provider: providerKind,
            stage: "callback",
          });
          diagnosticLogged = true;
          throw new Error("Missing OAuth callback state");
        }
        if (registeredProvider) {
          const currentClient = await getProviderClient(registeredProvider);
          if (
            !currentClient ||
            currentClient.version !== data.registeredClientVersion
          ) {
            logOAuthDiagnostic({
              category: "flow_rejected",
              provider: providerKind,
              stage: "callback",
            });
            diagnosticLogged = true;
            throw new Error("OAuth client changed");
          }
          const issuer = searchParams.get("iss");
          if (
            issuer &&
            issuer !== registeredProviderDefinition(registeredProvider).issuer
          ) {
            logOAuthDiagnostic({
              category: "flow_rejected",
              provider: providerKind,
              stage: "callback",
            });
            diagnosticLogged = true;
            throw new Error("Wrong authorization server");
          }
          exchangeStarted = true;
          await finishRegisteredOAuth(
            oauthProvider,
            registeredProvider,
            code,
            state
          );
        } else if (cimdProvider === "vercel") {
          exchangeStarted = true;
          await finishVercelCimdOAuth(oauthProvider, entry.url, code, state, {
            callbackIssuer: searchParams.get("iss") ?? undefined,
            scope: entry.oauthScopes,
          });
        } else {
          exchangeStarted = true;
          await finishOAuth(oauthProvider, entry.url, code, state, {
            callbackIssuer: searchParams.get("iss") ?? undefined,
            scope: entry.oauthScopes,
          });
        }
        success = Boolean(oauthProvider.data.tokens?.access_token);
      } catch (error) {
        if (!diagnosticLogged) {
          logOAuthDiagnostic({
            category: exchangeStarted
              ? callbackFailureCategory(error)
              : "callback_failed",
            provider: providerKind,
            stage: exchangeStarted ? "token_exchange" : "callback",
          });
          diagnosticLogged = true;
        }
        oauthProvider.invalidateCredentials("tokens");
      } finally {
        oauthProvider.invalidateCredentials("verifier");
      }
      if (!success && exchangeStarted && !diagnosticLogged) {
        logOAuthDiagnostic({
          category: "exchange_failed",
          provider: providerKind,
          stage: "token_exchange",
        });
      }
      // biome-ignore lint/performance/noDelete: OAuth callback consumes the contextual return destination with the one-use state.
      delete oauthProvider.data.returnTo;
      return {
        data: oauthProvider.data,
        error: success
          ? null
          : "Sign-in did not finish. Reconnect to try again.",
        status: success ? "connected" : "error",
        value: {
          result: success ? ("connected" as const) : ("error" as const),
          returnTo,
        },
      };
    });
    if (!outcome) {
      logOAuthDiagnostic({
        category: "connection_not_found",
        provider: providerKind,
        stage: "callback",
      });
      return redirect();
    }
    return redirect(outcome.returnTo ?? null, outcome.result);
  } catch {
    logOAuthDiagnostic({
      category: "callback_failed",
      provider: providerKind,
      stage: "callback",
    });
    return redirect();
  }
}
