import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  createRemoteJWKSet,
  decodeJwt,
  type JWTVerifyGetKey,
  jwtVerify,
} from "jose";
import type {
  PublicSubscriptionAttempt,
  SubscriptionAttempt,
  SubscriptionCredentials,
  SubscriptionModel,
  SubscriptionProvider,
} from "./subscription-types";
import { SubscriptionConnectionError } from "./subscription-types";

const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_AUTHORIZE = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const CHATGPT_TOKEN = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const CHATGPT_MODELS = "https://api.openai.com/v1/models";
const CHATGPT_CLIENT = "dynamic_agent_client";
const CHATGPT_SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const CHATGPT_REDIRECT = "http://127.0.0.1:1455/auth/callback";
const CHATGPT_ATTEMPT_MS = 10 * 60 * 1000;

const GROK_ISSUER = "https://auth.x.ai";
const GROK_DISCOVERY = `${GROK_ISSUER}/.well-known/openid-configuration`;
const GROK_CLIENT = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
const GROK_PROXY = "https://cli-chat-proxy.grok.com";
const GROK_MODELS = `${GROK_PROXY}/v1/models`;
const TRAILING_SLASH_RE = /\/$/u;
const WHITESPACE_RE = /\s+/u;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/u;
const ATTEMPT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const NETWORK_TIMEOUT_MS = 20_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const dynamicJwks = createRemoteJWKSet(
  new URL(`${CHATGPT_ISSUER}/.well-known/jwks.json`)
);

type FetchLike = typeof globalThis.fetch;

export interface SubscriptionProtocolOptions {
  attemptId?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  jwks?: JWTVerifyGetKey;
  now?: number | (() => number);
  redirectUri?: string;
  signal?: AbortSignal;
  verifyIdToken?: (
    token: string,
    context: { clientId: string; nonce?: string; now: number }
  ) => Promise<Record<string, unknown>>;
}

interface StartedSubscriptionAuth {
  attempt: SubscriptionAttempt;
  public: PublicSubscriptionAttempt;
}

interface Discovery {
  authorizationEndpoint?: string;
  deviceAuthorizationEndpoint: string;
  issuer: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
}

const fail = (
  message: string,
  code:
    | "connection_expired"
    | "connection_failed"
    | "provider_error" = "connection_failed"
): never => {
  throw new SubscriptionConnectionError(message, code);
};

const clock = (options: SubscriptionProtocolOptions) => {
  if (typeof options.now === "function") {
    return options.now();
  }
  return options.now ?? Date.now();
};
const requestFetch = (options: SubscriptionProtocolOptions) =>
  options.fetch ?? globalThis.fetch.bind(globalThis);

function timeoutSignal(signal?: AbortSignal): AbortSignal {
  if (!signal) {
    return AbortSignal.timeout(NETWORK_TIMEOUT_MS);
  }
  if (signal.aborted) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(NETWORK_TIMEOUT_MS)]);
}

function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function formRequest(
  fields: Record<string, string>,
  signal: AbortSignal
): RequestInit {
  return {
    body: new URLSearchParams(fields),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
    redirect: "error",
    signal,
  };
}

async function responseJson(
  response: Response,
  message: string
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = providerErrorCode(body);
    fail(
      message,
      code === "invalid_grant" ||
        code === "invalid_token" ||
        code === "token_revoked"
        ? "connection_expired"
        : "provider_error"
    );
  }
  const value: unknown = await response.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(message);
  }
  return value as Record<string, unknown>;
}

function providerErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const root = body as Record<string, unknown>;
  const candidate = root.error ?? root.code ?? root.type;
  if (typeof candidate === "string") {
    return candidate;
  }
  if (candidate && typeof candidate === "object") {
    const nested = candidate as Record<string, unknown>;
    const nestedCode = nested.code ?? nested.type;
    return typeof nestedCode === "string" ? nestedCode : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function providerClient(
  provider: SubscriptionProvider,
  options: SubscriptionProtocolOptions
): string {
  const key =
    provider === "chatgpt" ? "BUSY_CHATGPT_CLIENT_ID" : "BUSY_GROK_CLIENT_ID";
  return (
    text((options.env ?? process.env)[key]) ??
    (provider === "chatgpt" ? CHATGPT_CLIENT : GROK_CLIENT)
  );
}

function checkedUrl(
  value: unknown,
  allowedOrigin: string,
  label: string
): string {
  const url = text(value);
  if (!url) {
    throw new SubscriptionConnectionError(
      `The ${label} endpoint is unavailable.`
    );
  }
  const parsed = URL.parse(url);
  if (!parsed) {
    throw new SubscriptionConnectionError(
      `The ${label} endpoint is unavailable.`
    );
  }
  if (parsed.protocol !== "https:" || parsed.origin !== allowedOrigin) {
    throw new SubscriptionConnectionError(
      `The ${label} endpoint is unavailable.`
    );
  }
  return parsed.href;
}

function checkedVerificationUrl(value: unknown): string {
  const url = text(value) ?? fail("Grok did not issue a usable device code.");
  const parsed = URL.parse(url);
  if (!parsed) {
    throw new SubscriptionConnectionError(
      "Grok returned an invalid verification URL."
    );
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    !["auth.x.ai", "accounts.x.ai"].includes(parsed.hostname)
  ) {
    throw new SubscriptionConnectionError(
      "Grok returned an invalid verification URL."
    );
  }
  return parsed.href;
}

async function grokDiscovery(
  options: SubscriptionProtocolOptions
): Promise<Discovery> {
  const response = await requestFetch(options)(GROK_DISCOVERY, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: timeoutSignal(options.signal),
  });
  const body = await responseJson(
    response,
    "Grok authentication is unavailable."
  );
  const issuer = checkedUrl(
    body.issuer,
    GROK_ISSUER,
    "Grok authentication"
  ).replace(TRAILING_SLASH_RE, "");
  if (issuer !== GROK_ISSUER) {
    fail("Grok authentication is unavailable.");
  }
  return {
    authorizationEndpoint: body.authorization_endpoint
      ? checkedUrl(
          body.authorization_endpoint,
          GROK_ISSUER,
          "Grok authorization"
        )
      : undefined,
    deviceAuthorizationEndpoint: checkedUrl(
      body.device_authorization_endpoint,
      GROK_ISSUER,
      "Grok device authorization"
    ),
    issuer,
    tokenEndpoint: checkedUrl(body.token_endpoint, GROK_ISSUER, "Grok token"),
    userinfoEndpoint: checkedUrl(
      body.userinfo_endpoint,
      GROK_ISSUER,
      "Grok account"
    ),
  };
}

function publicAttempt(
  attemptId: string,
  attempt: SubscriptionAttempt,
  url: string
): PublicSubscriptionAttempt {
  return {
    attemptId,
    expiresAt: attempt.expiresAt,
    intervalMs: attempt.intervalMs,
    kind: attempt.kind,
    provider: attempt.provider,
    url,
    ...(attempt.userCode ? { userCode: attempt.userCode } : {}),
  };
}

const LOOPBACK_CALLBACK_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/auth\/callback$/u;

export function validateLoopbackRedirectUri(value: string): string {
  if (!LOOPBACK_CALLBACK_RE.test(value)) {
    fail("The subscription callback is invalid.");
  }
  const parsed =
    URL.parse(value) ?? fail("The subscription callback is invalid.");
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    Number(parsed.port) < 1 ||
    Number(parsed.port) > 65_535
  ) {
    fail("The subscription callback is invalid.");
  }
  return parsed.href;
}

export function attemptIdFromState(value: string): string | null {
  const [id] = value.split(".", 1);
  return ATTEMPT_ID_RE.test(id) ? id : null;
}

/** Start a browser (ChatGPT) or device-code (Grok) subscription login. */
export async function startSubscriptionAuth(
  provider: SubscriptionProvider,
  hostId: string,
  options: SubscriptionProtocolOptions = {}
): Promise<StartedSubscriptionAuth> {
  if (!text(hostId) || hostId.length > 256) {
    fail("The subscription host is invalid.");
  }
  const now = clock(options);
  const attemptId = options.attemptId ?? randomUUID();

  if (provider === "chatgpt") {
    const clientId = providerClient(provider, options);
    const verifier = randomSecret();
    const state = `${attemptId}.${randomSecret(24)}`;
    const nonce = randomSecret(24);
    const params = new URLSearchParams({
      agent_name_hint: "Busy",
      client_id: clientId,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
      ext_agent_host_id: hostId,
      nonce,
      redirect_uri: validateLoopbackRedirectUri(
        options.redirectUri ?? CHATGPT_REDIRECT
      ),
      resource: CHATGPT_RESOURCE,
      response_type: "code",
      scope: CHATGPT_SCOPE,
      state,
    });
    const attempt: SubscriptionAttempt = {
      clientId,
      expiresAt: now + CHATGPT_ATTEMPT_MS,
      hostId,
      intervalMs: 1000,
      kind: "browser",
      nonce,
      provider,
      redirectUri: validateLoopbackRedirectUri(
        options.redirectUri ?? CHATGPT_REDIRECT
      ),
      state,
      verifier,
    };
    return {
      attempt,
      public: publicAttempt(
        attemptId,
        attempt,
        `${CHATGPT_AUTHORIZE}?${params}`
      ),
    };
  }

  const discovery = await grokDiscovery(options);
  const clientId = providerClient(provider, options);
  const response = await requestFetch(options)(
    discovery.deviceAuthorizationEndpoint,
    formRequest(
      { client_id: clientId, scope: GROK_SCOPE },
      timeoutSignal(options.signal)
    )
  );
  const body = await responseJson(
    response,
    "Grok did not issue a device code."
  );
  const deviceCode =
    text(body.device_code) ?? fail("Grok did not issue a usable device code.");
  const userCode =
    text(body.user_code) ?? fail("Grok did not issue a usable device code.");
  const verificationUrl = checkedVerificationUrl(
    body.verification_uri_complete ?? body.verification_uri
  );
  const expiresAt = now + positiveNumber(body.expires_in, 900) * 1000;
  const attempt: SubscriptionAttempt = {
    clientId,
    deviceCode,
    expiresAt,
    hostId,
    intervalMs: positiveNumber(body.interval, 5) * 1000,
    kind: "device",
    provider,
    userCode,
  };
  return {
    attempt,
    public: publicAttempt(attemptId, attempt, verificationUrl),
  };
}

function ensureAttempt(
  attempt: SubscriptionAttempt,
  options: SubscriptionProtocolOptions
): void {
  if (
    !attempt ||
    (attempt.provider !== "chatgpt" && attempt.provider !== "grok")
  ) {
    fail("The subscription login is invalid.");
  }
  if (
    !Number.isFinite(attempt.expiresAt) ||
    attempt.expiresAt <= clock(options)
  ) {
    fail("The subscription login expired. Start again.");
  }
}

function parseCallback(value: string, attempt: SubscriptionAttempt): URL {
  const callback = URL.parse(value);
  if (!callback) {
    throw new SubscriptionConnectionError(
      "The subscription callback is invalid."
    );
  }
  const redirectUri = attempt.redirectUri ?? CHATGPT_REDIRECT;
  const expected = URL.parse(redirectUri);
  if (
    !expected ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname
  ) {
    fail("The subscription callback is invalid.");
  }
  if (callback.searchParams.get("state") !== attempt.state) {
    fail("The subscription callback could not be verified.");
  }
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    fail("The provider declined the subscription connection.");
  }
  if (!text(callback.searchParams.get("code"))) {
    fail("The subscription callback did not contain an authorization code.");
  }
  return callback;
}

export function validateSubscriptionCallback(
  value: string,
  attempt: SubscriptionAttempt
): URL {
  return parseCallbackShape(value, attempt);
}

function parseCallbackShape(value: string, attempt: SubscriptionAttempt): URL {
  const callback =
    URL.parse(value) ??
    fail("The subscription callback could not be verified.");
  const expected =
    URL.parse(attempt.redirectUri ?? CHATGPT_REDIRECT) ??
    fail("The subscription callback could not be verified.");
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.searchParams.get("state") !== attempt.state
  ) {
    fail("The subscription callback could not be verified.");
  }
  return callback;
}

async function verifyChatGptIdToken(
  token: string,
  clientId: string,
  nonce: string | undefined,
  options: SubscriptionProtocolOptions
): Promise<Record<string, unknown>> {
  if (options.verifyIdToken) {
    return options.verifyIdToken(token, {
      clientId,
      nonce,
      now: clock(options),
    });
  }
  const untrusted = (() => {
    try {
      return decodeJwt(token) as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!untrusted) {
    return fail("OpenAI returned an invalid identity token.");
  }
  const audience = Array.isArray(untrusted.aud)
    ? untrusted.aud
    : [untrusted.aud];
  if (!audience.includes(clientId)) {
    fail("OpenAI returned an identity token for another client.");
  }
  try {
    const { payload } = await jwtVerify(token, options.jwks ?? dynamicJwks, {
      algorithms: ["RS256", "ES256"],
      audience: clientId,
      clockTolerance: 5,
      currentDate: new Date(clock(options)),
      issuer: CHATGPT_ISSUER,
      requiredClaims: ["sub", "exp", "iat"],
    });
    if (nonce !== undefined && payload.nonce !== nonce) {
      fail("OpenAI returned an identity token for another sign-in.");
    }
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SubscriptionConnectionError) {
      throw error;
    }
    return fail("OpenAI returned an invalid identity token.");
  }
}

function accountIdFromClaims(claims: Record<string, unknown>): string {
  const auth = claims["https://api.openai.com/auth"];
  const accountId =
    auth && typeof auth === "object" && !Array.isArray(auth)
      ? text((auth as Record<string, unknown>).chatgpt_account_id)
      : null;
  return (
    accountId ??
    text(claims.sub) ??
    fail("The provider did not identify the connected account.")
  );
}

async function finishChatGpt(
  attempt: SubscriptionAttempt,
  callbackUrl: string,
  options: SubscriptionProtocolOptions
): Promise<SubscriptionCredentials> {
  const callback = parseCallback(callbackUrl, attempt);
  const issuedClientId = text(callback.searchParams.get("client_id"));
  const clientId =
    attempt.clientId === CHATGPT_CLIENT
      ? (issuedClientId ??
        fail("The OpenAI client registration could not be verified."))
      : (attempt.clientId ??
        fail("The OpenAI client registration could not be verified."));
  if (issuedClientId && issuedClientId !== clientId) {
    fail("The OpenAI client registration could not be verified.");
  }
  const code =
    text(callback.searchParams.get("code")) ??
    fail("The subscription callback did not contain an authorization code.");
  const verifier = attempt.verifier ?? fail("The ChatGPT login is invalid.");
  const redirectUri =
    attempt.redirectUri ?? fail("The ChatGPT login is invalid.");
  const response = await requestFetch(options)(
    CHATGPT_TOKEN,
    formRequest(
      {
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        resource: CHATGPT_RESOURCE,
      },
      timeoutSignal(options.signal)
    )
  );
  const body = await responseJson(
    response,
    "OpenAI could not finish the subscription connection."
  );
  const accessToken =
    text(body.access_token) ??
    fail("OpenAI did not grant ChatGPT plan access.");
  const refreshToken =
    text(body.refresh_token) ??
    fail("OpenAI did not grant ChatGPT plan access.");
  const idToken =
    text(body.id_token) ?? fail("OpenAI did not grant ChatGPT plan access.");
  const scope = text(body.scope)?.split(WHITESPACE_RE) ?? [];
  const returnedClientId = text(body.client_id);
  if (returnedClientId && returnedClientId !== clientId) {
    fail("OpenAI did not grant ChatGPT plan access.");
  }
  if (!scope.includes("chatgpt.tokens.use.direct")) {
    fail("OpenAI did not grant ChatGPT plan access.");
  }
  const claims = await verifyChatGptIdToken(
    idToken,
    clientId,
    attempt.nonce ?? fail("The ChatGPT login is invalid."),
    options
  );
  return {
    accessToken,
    accountId: accountIdFromClaims(claims),
    clientId,
    expiresAt: clock(options) + positiveNumber(body.expires_in, 3600) * 1000,
    refreshToken,
  };
}

async function grokUserId(
  token: string,
  endpoint: string,
  options: SubscriptionProtocolOptions
): Promise<string> {
  const response = await requestFetch(options)(endpoint, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    redirect: "error",
    signal: timeoutSignal(options.signal),
  });
  const body = await responseJson(
    response,
    "xAI could not identify the connected account."
  );
  return text(body.sub) ?? fail("xAI did not identify the connected account.");
}

async function finishGrok(
  attempt: SubscriptionAttempt,
  options: SubscriptionProtocolOptions
): Promise<SubscriptionCredentials | null> {
  const discovery = await grokDiscovery(options);
  const clientId = attempt.clientId ?? fail("The Grok login is invalid.");
  const deviceCode = attempt.deviceCode ?? fail("The Grok login is invalid.");
  const response = await requestFetch(options)(
    discovery.tokenEndpoint,
    formRequest(
      {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      },
      timeoutSignal(options.signal)
    )
  );
  if (response.status === 400) {
    const body: unknown = await response.json().catch(() => null);
    const error =
      body && typeof body === "object"
        ? text((body as Record<string, unknown>).error)
        : null;
    if (error === "authorization_pending") {
      return null;
    }
    if (error === "slow_down") {
      attempt.intervalMs = Math.min(
        Math.max(attempt.intervalMs + 5000, 1000),
        120_000
      );
      return null;
    }
    if (error === "expired_token") {
      fail("The Grok device code expired. Start again.");
    }
    if (error === "access_denied") {
      fail("The Grok subscription connection was declined.");
    }
    fail("xAI could not finish the subscription connection.");
  }
  const body = await responseJson(
    response,
    "xAI could not finish the subscription connection."
  );
  const accessToken =
    text(body.access_token) ??
    fail("xAI did not grant a usable subscription session.");
  const refreshToken =
    text(body.refresh_token) ??
    fail("xAI did not grant a usable subscription session.");
  const accountId = await grokUserId(
    accessToken,
    discovery.userinfoEndpoint,
    options
  );
  return {
    accessToken,
    accountId,
    clientId,
    expiresAt: clock(options) + positiveNumber(body.expires_in, 3600) * 1000,
    refreshToken,
  };
}

/** Finish a browser callback, or poll a device attempt. Grok returns null while authorization is pending. */
export function finishSubscriptionAuth(
  attempt: SubscriptionAttempt,
  callbackUrl?: string,
  options: SubscriptionProtocolOptions = {}
): Promise<SubscriptionCredentials | null> {
  ensureAttempt(attempt, options);
  if (attempt.provider === "chatgpt") {
    if (
      attempt.kind !== "browser" ||
      !callbackUrl ||
      !attempt.state ||
      !attempt.verifier ||
      !attempt.nonce
    ) {
      fail("A ChatGPT callback is required.");
    }
    const callback = callbackUrl ?? fail("A ChatGPT callback is required.");
    return finishChatGpt(attempt, callback, options);
  }
  if (attempt.kind !== "device" || !attempt.deviceCode || !attempt.clientId) {
    fail("A Grok device login is required.");
  }
  return finishGrok(attempt, options);
}

/** Refresh a plan token and keep account identity stable across rotations. */
export async function refreshSubscriptionCredentials(
  provider: SubscriptionProvider,
  credentials: SubscriptionCredentials,
  options: SubscriptionProtocolOptions = {}
): Promise<SubscriptionCredentials> {
  if (
    !(
      credentials.accessToken &&
      credentials.refreshToken &&
      credentials.clientId &&
      credentials.accountId
    )
  ) {
    fail("The subscription credentials are invalid.");
  }
  let endpoint = provider === "chatgpt" ? CHATGPT_TOKEN : "";
  let userinfo: string | null = null;
  if (provider === "grok") {
    const discovery = await grokDiscovery(options);
    endpoint = discovery.tokenEndpoint;
    userinfo = discovery.userinfoEndpoint;
  }
  const fields: Record<string, string> = {
    client_id: credentials.clientId,
    grant_type: "refresh_token",
    refresh_token: credentials.refreshToken,
  };
  if (provider === "chatgpt") {
    fields.resource = CHATGPT_RESOURCE;
  }
  const tokenEndpoint =
    endpoint || fail("The subscription token endpoint is unavailable.");
  const response = await requestFetch(options)(
    tokenEndpoint,
    formRequest(fields, timeoutSignal(options.signal))
  );
  const body = await responseJson(
    response,
    provider === "grok"
      ? "xAI could not refresh the subscription connection."
      : "OpenAI could not refresh the subscription connection."
  );
  const accessToken =
    text(body.access_token) ??
    fail("The provider did not return a refreshed subscription token.");
  const { accountId: originalAccountId } = credentials;
  let accountId = originalAccountId;
  const refreshedIdToken = text(body.id_token);
  if (provider === "chatgpt" && refreshedIdToken) {
    const claims = await verifyChatGptIdToken(
      refreshedIdToken,
      credentials.clientId,
      undefined,
      options
    );
    const refreshedAccountId = accountIdFromClaims(claims);
    if (refreshedAccountId !== credentials.accountId) {
      fail("The refreshed ChatGPT token belongs to another account.");
    }
    accountId = refreshedAccountId;
  }
  const next: SubscriptionCredentials = {
    accessToken,
    accountId,
    clientId: credentials.clientId,
    expiresAt: clock(options) + positiveNumber(body.expires_in, 3600) * 1000,
    refreshToken: text(body.refresh_token) ?? credentials.refreshToken,
  };
  if (
    userinfo &&
    (await grokUserId(next.accessToken, userinfo, options)) !==
      credentials.accountId
  ) {
    fail("The refreshed Grok token belongs to another account.");
  }
  return next;
}

async function listModelsRequest(
  provider: SubscriptionProvider,
  credentials: SubscriptionCredentials,
  options: SubscriptionProtocolOptions
): Promise<Record<string, unknown>> {
  const url = provider === "chatgpt" ? CHATGPT_MODELS : GROK_MODELS;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${credentials.accessToken}`,
  };
  if (provider === "grok") {
    headers["X-XAI-Token-Auth"] = "xai-grok-cli";
    headers["x-grok-client-identifier"] = "busy";
    headers["x-userid"] = credentials.accountId;
  }
  const response = await requestFetch(options)(url, {
    headers,
    redirect: "error",
    signal: timeoutSignal(options.signal),
  });
  return responseJson(
    response,
    provider === "grok"
      ? "xAI could not list models for this subscription."
      : "OpenAI could not list models for this subscription."
  );
}

/** Return only models advertised for this connected account. */
export async function listSubscriptionModels(
  provider: SubscriptionProvider,
  credentials: SubscriptionCredentials,
  options: SubscriptionProtocolOptions = {}
): Promise<SubscriptionModel[]> {
  const body = await listModelsRequest(provider, credentials, options);
  let rows: unknown[] = [];
  if (Array.isArray(body.models)) {
    rows = body.models;
  } else if (Array.isArray(body.data)) {
    rows = body.data;
  }
  const seen = new Set<string>();
  return rows.flatMap((row: unknown) => {
    if (!row || typeof row !== "object") {
      return [];
    }
    const item = row as Record<string, unknown>;
    const id = text(item.slug) ?? text(item.id);
    const label =
      text(item.display_name) ??
      text(item.displayName) ??
      text(item.name) ??
      id;
    if (!(id && label && MODEL_ID_RE.test(id))) {
      return [];
    }
    if (provider === "chatgpt" && item.visibility !== "list") {
      return [];
    }
    const namespacedId = `${provider}/${id}`;
    if (seen.has(namespacedId)) {
      return [];
    }
    seen.add(namespacedId);
    return [{ id: namespacedId, label }];
  });
}
