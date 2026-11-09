import { randomUUID } from "node:crypto";
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@ai-sdk/mcp";
import type { ConnectIntent } from "./intent";
import {
  assertPublicHttpUrl,
  assertPublicHttpUrlSync,
  guardedFetch,
  type NetworkGuardOptions,
} from "./network";
import { registeredHubOrigin } from "./provider-origin";

export const APP_CLIENT_NAME = "BUSY";
export const VERCEL_CIMD_CALLBACK_PATH = "/api/mcp/oauth/vercel/callback";
const REFRESH_MARGIN_MS = 60_000;
const TERMINAL_OAUTH_FAILURE =
  /invalid_grant|invalid_client|unauthorized_client|access_denied|status\s*401|status\s*403|no usable token/u;

export interface OAuthData {
  cimdProvider?: "vercel";
  clientInformation?: OAuthClientInformation;
  codeVerifier?: string;
  connectIntent?: ConnectIntent;
  flowStartedAt?: number;
  redirectOrigin?: string;
  registeredClientVersion?: string;
  registeredProvider?: "github" | "google";
  returnTo?: string;
  serverInformation?: OAuthAuthorizationServerInformation;
  state?: string;
  tokens?: OAuthTokens;
  tokensIssuedAt?: number;
}
/** A terminal OAuth condition that requires the user to authorize again. */
export class McpReconnectError extends Error {
  readonly code = "reconnect_required";

  constructor(
    message = "MCP authorization has expired; reconnect is required"
  ) {
    super(message);
    this.name = "McpReconnectError";
  }
}
/** A network/provider failure that can be retried without asking for consent. */
export class McpOAuthTransientError extends Error {
  readonly code = "oauth_temporarily_unavailable";

  constructor(message = "MCP authorization is temporarily unavailable") {
    super(message);
    this.name = "McpOAuthTransientError";
  }
}

interface ProviderOptions {
  connectionId: string;
  /** The Hub origin, without a path. */
  origin: string;
  /** A fixed callback URL for OAuth clients using CIMD. */
  redirectUrl?: string;
  scope?: string;
}

function httpOAuthAllowed(): boolean {
  return (
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test"
  );
}

function sameTokens(
  a: OAuthTokens | undefined,
  b: OAuthTokens | undefined
): boolean {
  if (!(a && b)) {
    return a === b;
  }
  return (
    a.access_token === b.access_token &&
    a.refresh_token === b.refresh_token &&
    a.token_type === b.token_type &&
    a.expires_in === b.expires_in
  );
}

function originOnly(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // biome-ignore lint/style/useErrorCause: Redirect validation deliberately returns a stable public error.
    throw new Error("OAuth redirect origin is invalid");
  }
  const httpAllowed = httpOAuthAllowed();
  if (
    (parsed.protocol !== "https:" &&
      !(httpAllowed && parsed.protocol === "http:")) ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error("OAuth redirect origin is invalid");
  }
  // A callback must always be rooted at the configured Hub origin. Paths in the
  // option would make it too easy to create an unintended redirect URI.
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("OAuth redirect origin is invalid");
  }
  return parsed.origin;
}

/**
 * Stateful only in memory: the caller persists `data` after each method call.
 * This keeps the SDK provider usable with a DB transaction and makes it
 * impossible for tokens to be accidentally returned in a route response.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  readonly connectionId: string;
  readonly origin: string;
  readonly redirectUrlOverride?: string;
  readonly scope?: string;
  data: OAuthData;
  pendingAuthorizationUrl: URL | null = null;

  // biome-ignore lint/style/useDefaultParameterLast: The SDK constructor keeps its established (data, options) call shape.
  constructor(data: OAuthData = {}, options: ProviderOptions) {
    this.connectionId = options.connectionId;
    if (!this.connectionId || this.connectionId.length > 200) {
      throw new Error("OAuth connection id is invalid");
    }
    this.origin = originOnly(options.origin);
    const inferredRedirectUrl =
      data.cimdProvider === "vercel"
        ? `${registeredHubOrigin(this.origin)}${VERCEL_CIMD_CALLBACK_PATH}`
        : undefined;
    if (
      inferredRedirectUrl &&
      options.redirectUrl !== undefined &&
      options.redirectUrl !== inferredRedirectUrl
    ) {
      throw new Error("OAuth redirect URL conflicts with the CIMD provider");
    }
    const redirectUrl = options.redirectUrl ?? inferredRedirectUrl;
    if (redirectUrl !== undefined) {
      const redirect = new URL(redirectUrl);
      if (
        (redirect.protocol !== "https:" &&
          !(httpOAuthAllowed() && redirect.protocol === "http:")) ||
        redirect.username ||
        redirect.password ||
        redirect.search ||
        redirect.hash
      ) {
        throw new Error("OAuth redirect URL is invalid");
      }
      this.redirectUrlOverride = redirect.href;
    }
    this.scope = options.scope;
    this.data = {
      ...data,
      tokens: data.tokens ? { ...data.tokens } : undefined,
    };
  }

  get redirectUrl(): string {
    return (
      this.redirectUrlOverride ??
      `${this.origin}/api/mcp/callback?cid=${encodeURIComponent(this.connectionId)}`
    );
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: APP_CLIENT_NAME,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      ...(this.scope ? { scope: this.scope } : {}),
    };
  }

  tokens(): OAuthTokens | undefined {
    return this.data.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    // Some providers omit refresh_token during rotation. Keep the previous one
    // so a successful refresh never destroys the only way to refresh again.
    this.data.tokens = {
      ...tokens,
      ...(tokens.refresh_token || !this.data.tokens?.refresh_token
        ? {}
        : { refresh_token: this.data.tokens.refresh_token }),
    };
    this.data.tokensIssuedAt = Date.now();
  }

  redirectToAuthorization(url: URL): void {
    this.pendingAuthorizationUrl = url;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.data.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.data.codeVerifier) {
      throw new McpReconnectError(
        "MCP OAuth flow is missing its PKCE verifier"
      );
    }
    return this.data.codeVerifier;
  }

  state(): string {
    return this.data.state ?? randomUUID();
  }

  saveState(state: string): void {
    this.data.state = state;
    this.data.flowStartedAt = Date.now();
  }

  storedState(): string | undefined {
    return this.data.state;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.data.clientInformation;
  }

  saveClientInformation(info: OAuthClientInformation): void {
    this.data.clientInformation = info;
  }

  isClientInformationDynamicallyRegistered(): boolean {
    return Boolean(this.data.clientInformation);
  }

  authorizationServerInformation():
    | OAuthAuthorizationServerInformation
    | undefined {
    return this.data.serverInformation;
  }

  saveAuthorizationServerInformation(
    info: OAuthAuthorizationServerInformation
  ): void {
    this.data.serverInformation = info;
  }

  // biome-ignore lint/style/useThisInClassMethods: The SDK requires this synchronous callback, which validates only its argument.
  validateAuthorizationServerURL(
    _serverUrl: string | URL,
    authorizationServerUrl: string | URL
  ): void {
    // The SDK calls this synchronous hook before its own metadata request. The
    // async guarded fetch below performs DNS validation for the actual request.
    assertPublicHttpUrlSync(authorizationServerUrl);
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier",
    context?: { tokens: OAuthTokens }
  ): void {
    if (context && !sameTokens(this.data.tokens, context.tokens)) {
      return;
    }
    if (scope === "all" || scope === "client") {
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes persisted OAuth metadata.
      delete this.data.clientInformation;
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes persisted OAuth metadata.
      delete this.data.serverInformation;
    }
    if (scope === "all" || scope === "tokens") {
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes encrypted tokens.
      delete this.data.tokens;
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes encrypted token metadata.
      delete this.data.tokensIssuedAt;
    }
    if (scope === "all" || scope === "verifier") {
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes one-use PKCE state.
      delete this.data.codeVerifier;
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes one-use OAuth state.
      delete this.data.state;
      // biome-ignore lint/performance/noDelete: Invalidating credentials deliberately removes one-use OAuth state.
      delete this.data.flowStartedAt;
    }
  }
}

function networkFetch(options: NetworkGuardOptions = {}): typeof fetch {
  return (input, init) => guardedFetch(input, init, options);
}

export type OAuthRunOptions = NetworkGuardOptions & {
  scope?: string;
  callbackIssuer?: string;
};

/** Run discovery/DCR and either refresh an existing grant or capture a redirect. */
export async function startOAuth(
  provider: McpOAuthProvider,
  serverUrl: string | URL,
  options: OAuthRunOptions = {}
): Promise<{
  result: "AUTHORIZED" | "REDIRECT";
  authorizationUrl: URL | null;
}> {
  await assertPublicHttpUrl(serverUrl, options);
  provider.pendingAuthorizationUrl = null;
  const result = await auth(provider, {
    serverUrl,
    ...(options.scope ? { scope: options.scope } : {}),
    fetchFn: networkFetch(options),
  });
  const authorizationUrl = provider.pendingAuthorizationUrl;
  if (result === "REDIRECT" && !authorizationUrl) {
    throw new Error("OAuth provider did not return an authorization URL");
  }
  return { authorizationUrl, result };
}

/** Complete a callback using the same provider state and PKCE verifier. */
export async function finishOAuth(
  provider: McpOAuthProvider,
  serverUrl: string | URL,
  authorizationCode: string,
  callbackState: string,
  options: OAuthRunOptions = {}
): Promise<"AUTHORIZED"> {
  if (
    !(authorizationCode && callbackState && provider.storedState()) ||
    provider.storedState() !== callbackState
  ) {
    throw new McpReconnectError("MCP OAuth callback state is invalid");
  }
  await assertPublicHttpUrl(serverUrl, options);
  const result = await auth(provider, {
    authorizationCode,
    callbackState,
    serverUrl,
    ...(options.callbackIssuer
      ? { callbackIssuer: options.callbackIssuer }
      : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    fetchFn: networkFetch(options),
  });
  if (result !== "AUTHORIZED") {
    throw new Error("OAuth callback did not authorize the connection");
  }
  // A callback is one-use: do not leave a reusable state/verifier in a
  // process snapshot or a later callback transaction.
  // biome-ignore lint/performance/noDelete: Completion removes one-use OAuth state before the next transaction.
  delete provider.data.state;
  // biome-ignore lint/performance/noDelete: Completion removes one-use PKCE state before the next transaction.
  delete provider.data.codeVerifier;
  // biome-ignore lint/performance/noDelete: Completion removes one-use OAuth state before the next transaction.
  delete provider.data.flowStartedAt;
  provider.pendingAuthorizationUrl = null;
  return result;
}

function terminalOAuthFailure(error: unknown): boolean {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  return TERMINAL_OAUTH_FAILURE.test(`${name} ${message}`);
}

/** Return a live token, refreshing it when it is expired or near expiry. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Refresh flow combines expiry, reconnect, terminal-provider, and transient-error states.
export async function freshToken(
  provider: McpOAuthProvider,
  serverUrl: string | URL,
  now = Date.now(),
  options: OAuthRunOptions = {}
): Promise<{ token: string; expiresAt?: number }> {
  const tokens = provider.tokens();
  if (!tokens?.access_token) {
    throw new McpReconnectError("MCP connection is not authorized");
  }
  if (tokens.expires_in === null || tokens.expires_in === undefined) {
    return { token: tokens.access_token };
  }

  const issuedAt = provider.data.tokensIssuedAt;
  const expiresAt =
    issuedAt === null || issuedAt === undefined
      ? undefined
      : issuedAt + tokens.expires_in * 1000;
  if (
    expiresAt !== null &&
    expiresAt !== undefined &&
    expiresAt - now > REFRESH_MARGIN_MS
  ) {
    return { expiresAt, token: tokens.access_token };
  }
  if (!tokens.refresh_token) {
    throw new McpReconnectError(
      "MCP access token expired; reconnect is required"
    );
  }

  try {
    const result = await startOAuth(provider, serverUrl, options);
    if (result.result !== "AUTHORIZED") {
      throw new McpReconnectError(
        "MCP access token expired; reconnect is required"
      );
    }
    const refreshed = provider.tokens();
    if (!refreshed?.access_token) {
      throw new McpReconnectError("MCP connection is not authorized");
    }
    const refreshedExpiry =
      refreshed.expires_in === null || refreshed.expires_in === undefined
        ? undefined
        : (provider.data.tokensIssuedAt ?? Date.now()) +
          refreshed.expires_in * 1000;
    return refreshedExpiry === null || refreshedExpiry === undefined
      ? { token: refreshed.access_token }
      : { expiresAt: refreshedExpiry, token: refreshed.access_token };
  } catch (error) {
    if (error instanceof McpReconnectError || terminalOAuthFailure(error)) {
      if (error instanceof McpReconnectError) {
        throw error;
      }
      // biome-ignore lint/style/useErrorCause: OAuth provider errors are intentionally collapsed to a stable reconnect error.
      throw new McpReconnectError();
    }
    if (error instanceof McpOAuthTransientError) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: OAuth provider errors are intentionally collapsed to a stable transient error.
    throw new McpOAuthTransientError();
  }
}
