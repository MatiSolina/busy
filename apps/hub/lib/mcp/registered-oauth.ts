import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import {
  assertPublicHttpUrl,
  guardedFetch,
  type NetworkGuardOptions,
} from "./network";
import {
  finishOAuth,
  type McpOAuthProvider,
  McpOAuthTransientError,
  McpReconnectError,
  type OAuthData,
  startOAuth,
} from "./oauth";
import {
  logOAuthDiagnostic,
  type OAuthDiagnosticCategory,
  type OAuthDiagnosticProviderError,
} from "./oauth-diagnostics";
import { registeredHubOrigin } from "./provider-origin";

export type RegisteredProvider = "github" | "google";
export type CimdProvider = "vercel";

const VERCEL_AUTHORIZATION_SERVER = "https://vercel.com";
const VERCEL_TOKEN_ENDPOINT = "https://api.vercel.com/login/oauth/token";
const CIMD_DOCUMENT_PATH = "/.well-known/busy-mcp-client";
const CIMD_CALLBACK_PATH = "/api/mcp/oauth/vercel/callback";

export interface RegisteredClient {
  clientId: string;
  clientSecret: string;
  /** Version of the registered OAuth client configuration. */
  version: string;
}

/** OAuthData fields added by the registered-client flow. */
export type RegisteredOAuthData = OAuthData & {
  registeredProvider?: RegisteredProvider;
  registeredClientVersion?: string;
};

export type RegisteredOAuthOptions = NetworkGuardOptions & {
  callbackIssuer?: string;
  scope?: string;
};

interface RegisteredDefinition {
  authorizationEndpoint: string;
  authorizationServerUrl: string;
  defaultScope: string;
  /** Issuer returned in the authorization response's optional RFC 9207 issuer parameter. */
  issuer: string;
  tokenEndpoint: string;
}

const REGISTERED: Record<RegisteredProvider, RegisteredDefinition> = {
  github: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    authorizationServerUrl: "https://github.com",
    defaultScope: "read:user user:email",
    issuer: "https://github.com/login/oauth",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
  },
  google: {
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    authorizationServerUrl: "https://accounts.google.com",
    defaultScope: "openid email profile",
    issuer: "https://accounts.google.com",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
  },
};

export function registeredProviderDefinition(
  provider: RegisteredProvider
): RegisteredDefinition {
  return REGISTERED[provider];
}

function definitionFor(provider: string): RegisteredDefinition {
  if (provider !== "github" && provider !== "google") {
    throw new McpReconnectError("MCP OAuth provider is not registered");
  }
  return REGISTERED[provider];
}

function dataFor(provider: McpOAuthProvider): RegisteredOAuthData {
  return provider.data as RegisteredOAuthData;
}

function callbackOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // biome-ignore lint/style/useErrorCause: Callback validation deliberately returns a stable public error.
    throw new Error("OAuth callback origin is invalid");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("OAuth callback origin is invalid");
  }
  if (
    url.protocol === "http:" &&
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test"
  ) {
    throw new Error("OAuth callback origin is invalid");
  }
  return url.origin;
}

/** The callback used by registered providers; exact byte identity is required by OAuth. */
export function registeredCallbackUrl(
  origin: string,
  providerId: RegisteredProvider
): string {
  definitionFor(providerId);
  return `${callbackOrigin(origin)}/api/mcp/oauth/${encodeURIComponent(providerId)}/callback`;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { challenge, verifier };
}

function clientInformation(
  definition: RegisteredDefinition,
  client: RegisteredClient
): OAuthClientInformation {
  if (!(client.clientId && client.clientSecret && client.version)) {
    throw new Error("Registered OAuth client is incomplete");
  }
  return {
    authorization_server: definition.authorizationServerUrl,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    issuer: definition.issuer,
    token_endpoint: definition.tokenEndpoint,
  };
}

function setRegisteredBinding(
  provider: McpOAuthProvider,
  providerId: RegisteredProvider,
  client: RegisteredClient
): {
  definition: RegisteredDefinition;
  data: RegisteredOAuthData;
  callbackUrl: string;
} {
  const definition = definitionFor(providerId);
  const data = dataFor(provider);
  data.registeredProvider = providerId;
  data.registeredClientVersion = client.version;
  data.clientInformation = clientInformation(definition, client);
  data.serverInformation = {
    authorizationServerUrl: definition.authorizationServerUrl,
    issuer: definition.issuer,
    tokenEndpoint: definition.tokenEndpoint,
  };
  data.redirectOrigin = provider.origin;
  return {
    callbackUrl: registeredCallbackUrl(provider.origin, providerId),
    data,
    definition,
  };
}

export interface RegisteredOAuthStart {
  authorizationUrl: URL;
  state: string;
}

export function vercelCimdClientId(origin?: string): string {
  return `${registeredHubOrigin(origin)}${CIMD_DOCUMENT_PATH}`;
}

export function vercelCimdCallbackUrl(origin: string): string {
  return `${registeredHubOrigin(origin)}${CIMD_CALLBACK_PATH}`;
}

export function vercelCimdMetadata(origin?: string) {
  const canonicalOrigin = registeredHubOrigin(origin);
  return {
    client_id: `${canonicalOrigin}${CIMD_DOCUMENT_PATH}`,
    client_name: "Busy",
    client_uri: canonicalOrigin,
    grant_types: ["authorization_code", "refresh_token"],
    redirect_uris: [`${canonicalOrigin}${CIMD_CALLBACK_PATH}`],
    response_types: ["code"],
    scope: "openid",
    token_endpoint_auth_method: "none",
    token_endpoint_auth_methods_supported: ["none"],
  } as const;
}

function vercelCimdBinding(provider: McpOAuthProvider): void {
  const origin = registeredHubOrigin(provider.origin);
  const clientId = `${origin}${CIMD_DOCUMENT_PATH}`;
  const { data } = provider;
  data.cimdProvider = "vercel";
  data.clientInformation = {
    authorization_server: VERCEL_AUTHORIZATION_SERVER,
    client_id: clientId,
    issuer: VERCEL_AUTHORIZATION_SERVER,
    token_endpoint: VERCEL_TOKEN_ENDPOINT,
  };
  data.serverInformation = {
    authorizationServerUrl: VERCEL_AUTHORIZATION_SERVER,
    issuer: VERCEL_AUTHORIZATION_SERVER,
    tokenEndpoint: VERCEL_TOKEN_ENDPOINT,
  };
  data.redirectOrigin = origin;
}

export async function startVercelCimdOAuth(
  provider: McpOAuthProvider,
  serverUrl: string,
  options: RegisteredOAuthOptions = {}
): Promise<RegisteredOAuthStart> {
  vercelCimdBinding(provider);
  const state = `${provider.connectionId}.${randomUUID()}`;
  provider.saveState(state);
  const result = await startOAuth(provider, serverUrl, {
    ...options,
    scope: options.scope ?? "openid",
  });
  if (result.result !== "REDIRECT" || !result.authorizationUrl) {
    throw new McpReconnectError("Vercel OAuth did not return a redirect");
  }
  return { authorizationUrl: result.authorizationUrl, state };
}

export function finishVercelCimdOAuth(
  provider: McpOAuthProvider,
  serverUrl: string,
  authorizationCode: string,
  callbackState: string,
  options: RegisteredOAuthOptions = {}
): Promise<"AUTHORIZED"> {
  const { data } = provider;
  const origin = registeredHubOrigin(provider.origin);
  if (
    data.cimdProvider !== "vercel" ||
    data.clientInformation?.client_id !== `${origin}${CIMD_DOCUMENT_PATH}`
  ) {
    throw new McpReconnectError("Vercel CIMD binding is missing or changed");
  }
  if (
    options.callbackIssuer !== undefined &&
    options.callbackIssuer !== VERCEL_AUTHORIZATION_SERVER
  ) {
    throw new McpReconnectError("Vercel OAuth issuer is not trusted");
  }
  return finishOAuth(provider, serverUrl, authorizationCode, callbackState, {
    ...options,
    scope: options.scope ?? "openid",
  });
}

/**
 * Start a registered OAuth client flow without metadata discovery or DCR.
 * Client credentials are stored only in the provider snapshot, which callers
 * persist with the encrypted OAuth row.
 */
export function startRegisteredOAuth(
  provider: McpOAuthProvider,
  providerId: RegisteredProvider,
  client: RegisteredClient,
  options: Pick<RegisteredOAuthOptions, "scope"> = {}
): RegisteredOAuthStart {
  const { definition, data, callbackUrl } = setRegisteredBinding(
    provider,
    providerId,
    client
  );
  const { verifier, challenge } = pkce();
  const state = `${provider.connectionId}.${randomUUID()}`;
  data.codeVerifier = verifier;
  data.state = state;
  data.flowStartedAt = Date.now();
  const query = new URLSearchParams({
    client_id: client.clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: callbackUrl,
    response_type: "code",
    scope: options.scope?.trim() || definition.defaultScope,
    state,
  });
  if (providerId === "google") {
    query.set("access_type", "offline");
    query.set("prompt", "consent");
    // Each marketplace entry owns its scope set. Google documents that true
    // unions prior grants into the next token, which would make Gmail and
    // Calendar connections silently accumulate permissions on one client.
    query.set("include_granted_scopes", "false");
  }
  return {
    authorizationUrl: new URL(`${definition.authorizationEndpoint}?${query}`),
    state,
  };
}

function tokenErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { error } = value as Record<string, unknown>;
  return typeof error === "string" ? error : null;
}

const PROVIDER_ERROR_CODES = new Set<OAuthDiagnosticProviderError>([
  "access_denied",
  "bad_refresh_token",
  "bad_verification_code",
  "expired_token",
  "incorrect_client_credentials",
  "invalid_client",
  "invalid_grant",
  "redirect_uri_mismatch",
  "unauthorized_client",
]);

function providerErrorCode(
  code: string | null
): OAuthDiagnosticProviderError | undefined {
  return code && PROVIDER_ERROR_CODES.has(code as OAuthDiagnosticProviderError)
    ? (code as OAuthDiagnosticProviderError)
    : undefined;
}

function tokenFailureCategory(
  status: number,
  code: string | null
): OAuthDiagnosticCategory {
  if (providerErrorCode(code)) {
    return "provider_error";
  }
  if (status === 429 || status >= 500) {
    return "transient_http";
  }
  if (status === 401 || status === 403) {
    return "authorization_http";
  }
  return "invalid_response";
}

function logTokenFailure(
  provider: RegisteredProvider,
  stage: "token_exchange" | "token_refresh",
  status: number,
  code: string | null
): void {
  const safeError = providerErrorCode(code);
  logOAuthDiagnostic({
    category: tokenFailureCategory(status, code),
    ...(safeError ? { providerError: safeError } : {}),
    provider,
    stage,
  });
}

function isTerminalTokenError(code: string | null, status: number): boolean {
  return (
    status === 401 ||
    status === 403 ||
    code === "bad_verification_code" ||
    code === "incorrect_client_credentials" ||
    code === "expired_token" ||
    code === "bad_refresh_token" ||
    code === "invalid_grant" ||
    code === "invalid_client" ||
    code === "redirect_uri_mismatch" ||
    code === "unauthorized_client" ||
    code === "access_denied"
  );
}

async function readTokenResponse(
  response: Response,
  provider: RegisteredProvider,
  stage: "token_exchange" | "token_refresh"
): Promise<OAuthTokens> {
  let json: unknown;
  try {
    const text = await response.text();
    json = JSON.parse(text);
  } catch {
    logTokenFailure(provider, stage, response.status, null);
    // biome-ignore lint/style/useErrorCause: OAuth provider errors are intentionally collapsed to a stable transient error.
    throw new McpOAuthTransientError();
  }

  const errorCode = tokenErrorCode(json);
  if (errorCode && isTerminalTokenError(errorCode, response.status)) {
    logTokenFailure(provider, stage, response.status, errorCode);
    throw new McpReconnectError();
  }
  if (!response.ok) {
    logTokenFailure(provider, stage, response.status, errorCode);
    throw new McpOAuthTransientError();
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    logTokenFailure(provider, stage, response.status, null);
    throw new McpOAuthTransientError();
  }
  const record = json as Record<string, unknown>;
  if (
    typeof record.access_token !== "string" ||
    !record.access_token ||
    typeof record.token_type !== "string" ||
    !record.token_type
  ) {
    logTokenFailure(provider, stage, response.status, null);
    throw new McpOAuthTransientError();
  }
  if (
    record.expires_in !== undefined &&
    (typeof record.expires_in !== "number" ||
      !Number.isFinite(record.expires_in) ||
      record.expires_in < 0)
  ) {
    logTokenFailure(provider, stage, response.status, null);
    throw new McpOAuthTransientError();
  }
  if (
    record.refresh_token !== undefined &&
    typeof record.refresh_token !== "string"
  ) {
    logTokenFailure(provider, stage, response.status, null);
    throw new McpOAuthTransientError();
  }
  if (record.scope !== undefined && typeof record.scope !== "string") {
    logTokenFailure(provider, stage, response.status, null);
    throw new McpOAuthTransientError();
  }
  return {
    access_token: record.access_token,
    token_type: record.token_type,
    ...(record.expires_in === undefined
      ? {}
      : { expires_in: record.expires_in }),
    ...(record.refresh_token === undefined
      ? {}
      : { refresh_token: record.refresh_token }),
    ...(record.scope === undefined ? {} : { scope: record.scope }),
  };
}

function verifyBinding(
  provider: McpOAuthProvider,
  providerId: RegisteredProvider
): {
  definition: RegisteredDefinition;
  data: RegisteredOAuthData;
  client: OAuthClientInformation;
  callbackUrl: string;
} {
  const definition = definitionFor(providerId);
  const data = dataFor(provider);
  const client = data.clientInformation;
  if (
    data.registeredProvider !== providerId ||
    !data.registeredClientVersion ||
    !client?.client_id ||
    !client.client_secret ||
    client.token_endpoint !== definition.tokenEndpoint ||
    client.authorization_server !== definition.authorizationServerUrl
  ) {
    throw new McpReconnectError(
      "MCP registered OAuth binding is missing or changed"
    );
  }
  if (
    data.serverInformation?.tokenEndpoint !== definition.tokenEndpoint ||
    data.serverInformation.authorizationServerUrl !==
      definition.authorizationServerUrl
  ) {
    throw new McpReconnectError(
      "MCP registered OAuth server binding is missing or changed"
    );
  }
  return {
    callbackUrl: registeredCallbackUrl(provider.origin, providerId),
    client,
    data,
    definition,
  };
}

function networkFetch(options: NetworkGuardOptions): typeof fetch {
  return (input, init) => guardedFetch(input, init, options);
}

/** Exchange a registered-provider authorization code using the pinned client snapshot. */
export async function finishRegisteredOAuth(
  provider: McpOAuthProvider,
  providerId: RegisteredProvider,
  authorizationCode: string,
  callbackState: string,
  options: RegisteredOAuthOptions = {}
): Promise<"AUTHORIZED"> {
  if (!(authorizationCode && callbackState)) {
    throw new McpReconnectError("MCP OAuth callback is invalid");
  }
  const { definition, data, client, callbackUrl } = verifyBinding(
    provider,
    providerId
  );
  if (
    !data.state ||
    data.state !== callbackState ||
    !callbackState.startsWith(`${provider.connectionId}.`)
  ) {
    throw new McpReconnectError("MCP OAuth callback state is invalid");
  }
  if (!client.client_secret) {
    throw new McpReconnectError("MCP OAuth client credentials are missing");
  }
  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: client.client_secret,
    code: authorizationCode,
    code_verifier: data.codeVerifier ?? "",
    grant_type: "authorization_code",
    redirect_uri: callbackUrl,
  });
  if (!data.codeVerifier) {
    throw new McpReconnectError("MCP OAuth callback PKCE verifier is missing");
  }
  if (!client.client_secret) {
    throw new McpReconnectError("MCP OAuth client credentials are missing");
  }

  try {
    await assertPublicHttpUrl(definition.tokenEndpoint, options);
    const response = await networkFetch(options)(definition.tokenEndpoint, {
      body: params,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const tokens = await readTokenResponse(
      response,
      providerId,
      "token_exchange"
    );
    provider.saveTokens(tokens);
  } catch (error) {
    if (
      error instanceof McpReconnectError ||
      error instanceof McpOAuthTransientError
    ) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: OAuth provider errors are intentionally collapsed to a stable transient error.
    throw new McpOAuthTransientError();
  }
  // biome-ignore lint/performance/noDelete: Callback completion removes one-use OAuth state before encrypting the row.
  delete data.state;
  // biome-ignore lint/performance/noDelete: Callback completion removes one-use PKCE state before encrypting the row.
  delete data.codeVerifier;
  // biome-ignore lint/performance/noDelete: Callback completion removes one-use OAuth state before encrypting the row.
  delete data.flowStartedAt;
  return "AUTHORIZED";
}

/** Refresh a registered-provider token without rediscovery or client rotation. */
export async function freshRegisteredToken(
  provider: McpOAuthProvider,
  providerId: RegisteredProvider,
  now = Date.now(),
  options: RegisteredOAuthOptions = {}
): Promise<{ token: string; expiresAt?: number }> {
  const { definition, data, client } = verifyBinding(provider, providerId);
  const clientSecret = client.client_secret;
  if (!clientSecret) {
    throw new McpReconnectError("MCP OAuth client credentials are missing");
  }
  const { tokens } = data;
  if (!tokens?.access_token) {
    throw new McpReconnectError("MCP connection is not authorized");
  }
  if (tokens.expires_in === null || tokens.expires_in === undefined) {
    return { token: tokens.access_token };
  }
  const expiresAt =
    data.tokensIssuedAt === null || data.tokensIssuedAt === undefined
      ? undefined
      : data.tokensIssuedAt + tokens.expires_in * 1000;
  if (
    expiresAt !== null &&
    expiresAt !== undefined &&
    expiresAt - now > 60_000
  ) {
    return { expiresAt, token: tokens.access_token };
  }
  if (!tokens.refresh_token) {
    throw new McpReconnectError(
      "MCP access token expired; reconnect is required"
    );
  }

  const params = new URLSearchParams({
    client_id: client.client_id,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  try {
    await assertPublicHttpUrl(definition.tokenEndpoint, options);
    const response = await networkFetch(options)(definition.tokenEndpoint, {
      body: params,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
    });
    const refreshed = await readTokenResponse(
      response,
      providerId,
      "token_refresh"
    );
    provider.saveTokens(refreshed);
  } catch (error) {
    if (
      error instanceof McpReconnectError ||
      error instanceof McpOAuthTransientError
    ) {
      throw error;
    }
    // biome-ignore lint/style/useErrorCause: OAuth provider errors are intentionally collapsed to a stable transient error.
    throw new McpOAuthTransientError();
  }
  const current = provider.tokens();
  if (!current?.access_token) {
    throw new McpReconnectError("MCP connection is not authorized");
  }
  const currentExpiry =
    current.expires_in === null || current.expires_in === undefined
      ? undefined
      : (data.tokensIssuedAt ?? Date.now()) + current.expires_in * 1000;
  return currentExpiry === null || currentExpiry === undefined
    ? { token: current.access_token }
    : { expiresAt: currentExpiry, token: current.access_token };
}
