export type OAuthDiagnosticProvider =
  | "github"
  | "google"
  | "vercel"
  | "unknown";

export type OAuthDiagnosticProviderError =
  | "access_denied"
  | "bad_refresh_token"
  | "bad_verification_code"
  | "expired_token"
  | "incorrect_client_credentials"
  | "invalid_client"
  | "invalid_grant"
  | "redirect_uri_mismatch"
  | "unauthorized_client";

export interface OAuthDiagnostic {
  category: OAuthDiagnosticCategory;
  provider: OAuthDiagnosticProvider;
  providerError?: OAuthDiagnosticProviderError;
  stage: "callback" | "token_exchange" | "token_refresh";
}

export type OAuthDiagnosticCategory =
  | "authorization_http"
  | "browser_binding_mismatch"
  | "callback_failed"
  | "connection_not_found"
  | "exchange_failed"
  | "flow_rejected"
  | "invalid_callback_state"
  | "invalid_response"
  | "missing_authorization_code"
  | "origin_rejected"
  | "provider_denied"
  | "provider_error"
  | "reconnect_required"
  | "transient_failure"
  | "transient_http";

/**
 * Keep OAuth diagnostics deliberately data-free. The arguments are a closed
 * set of labels so provider responses, credentials, state and authorization
 * codes cannot accidentally reach production logs.
 */
export function logOAuthDiagnostic(input: OAuthDiagnostic): void {
  console.warn("mcp.oauth", {
    category: input.category,
    ...(input.providerError ? { providerError: input.providerError } : {}),
    provider: input.provider,
    stage: input.stage,
  });
}
