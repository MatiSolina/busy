import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  prepareSubscriptionBody,
  subscriptionHeaders,
  subscriptionUrl,
} from "../ai/inference";
import type {
  SubscriptionCredentials,
  SubscriptionModel,
  SubscriptionProvider,
} from "../ai/subscription-types";
import type { Billing } from "../bots/models";
import {
  observeOperation,
  operationErrorCode,
} from "../operation-observability";

/** A host fetch compatible with libfx's public `fetch` option. */
export type FxFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface CodeTaskProfile {
  billing: Billing;
  fast: boolean;
  model: string;
  sessionId: string;
  taskId: string;
}

/** Busy Fast is a Gateway service tier, separate from libfx's native Fast capability. */
export function codeTaskModel(
  profile: Pick<CodeTaskProfile, "billing" | "model">
) {
  const id =
    profile.billing === "chatgpt" || profile.billing === "grok"
      ? profile.model.slice(profile.billing.length + 1)
      : profile.model;
  // Explicitly clear native Fast when reopening sessions saved by older hubs.
  return { fast: false, id };
}

export type CodeTaskLookup = (
  sessionId: string
) => Promise<CodeTaskProfile | null>;

export interface SubscriptionAccess {
  credentials: SubscriptionCredentials;
  models: SubscriptionModel[];
}

export interface FxProviderProfile {
  /** Stable fx agent name. Every process using this name must use this profile. */
  agentName: string;
  billing: Billing;
  credentialMode: "vercel-oidc" | "token-pass" | "busy-subscription";
  provider: "gateway" | "codex" | "grok";
  /** Fx's native subscription provider cannot use Busy's Responses grant directly. */
  requiresBusyTransport: boolean;
  transport: "gateway" | "busy-responses";
}

/**
 * Returns stable, credential-free fx configuration for one billing mode.
 *
 * The function deliberately does not read environment variables. The caller
 * supplies credentials and the request transport separately, which prevents
 * fx's ambient `AI_GATEWAY_API_KEY` fallback from changing a task's billing.
 */
export function providerOptions(billing: Billing): FxProviderProfile {
  switch (billing) {
    case "gateway":
      return {
        agentName: "busy-code-gateway",
        billing,
        credentialMode: "vercel-oidc",
        provider: "gateway",
        requiresBusyTransport: false,
        transport: "gateway",
      };
    case "token-pass":
      return {
        agentName: "busy-code-token-pass",
        billing,
        credentialMode: "token-pass",
        provider: "gateway",
        requiresBusyTransport: false,
        transport: "gateway",
      };
    case "chatgpt":
      return {
        agentName: "busy-code-chatgpt",
        billing,
        credentialMode: "busy-subscription",
        provider: "codex",
        requiresBusyTransport: true,
        transport: "busy-responses",
      };
    case "grok":
      return {
        agentName: "busy-code-grok",
        billing,
        credentialMode: "busy-subscription",
        provider: "grok",
        requiresBusyTransport: true,
        transport: "busy-responses",
      };
    default:
      throw new Error(`Unsupported fx billing profile: ${String(billing)}`);
  }
}

/**
 * The only credentials a model request may receive. Busy refreshes encrypted
 * subscription grants itself; `refreshToken` must never be handed to fx.
 */
export function accessTokenOnly(credentials: SubscriptionCredentials): {
  accessToken: string;
  accountId: string;
  expiresAt: number;
} {
  return {
    accessToken: credentials.accessToken,
    accountId: credentials.accountId,
    expiresAt: credentials.expiresAt,
  };
}

export interface FxTransportDependencies {
  fetch?: typeof fetch;
  /** Resolve a Vercel OIDC-backed Gateway credential. Never read AI_GATEWAY_API_KEY here. */
  getGatewayCredential: (profile: CodeTaskProfile) => Promise<string>;
  /** Optional prevalidated Gateway catalog; the runtime may instead use fx's modelCatalog option. */
  getGatewayModelCatalog?: (profile: CodeTaskProfile) => Promise<unknown>;
  getSubscriptionAccess: (
    provider: SubscriptionProvider
  ) => Promise<SubscriptionAccess>;
  /** Resolve the explicit Token Pass key. Never fall through to Gateway/OIDC. */
  getTokenPassCredential: (profile: CodeTaskProfile) => Promise<string>;
  lookupTask: CodeTaskLookup;
  onGenerationId?: (
    profile: CodeTaskProfile,
    generationId: string
  ) => void | Promise<void>;
}

const FX_SESSION_HEADERS = [
  "session-id",
  "x-session-id",
  "x-grok-conv-id",
  "x-code-task-id",
  "x-fx-task-id",
] as const;
const GATEWAY_ORIGINS = new Set([
  "https://ai-gateway.vercel.sh",
  "https://gateway.ai.vercel.sh",
]);
const GATEWAY_MODELS_URL =
  "https://ai-gateway.vercel.sh/coding-agent/v1/models";
const GATEWAY_GENERATION_URL = "https://ai-gateway.vercel.sh/v1/generation";
const CODEX_ORIGIN = "https://chatgpt.com";
const GROK_ORIGIN = "https://cli-chat-proxy.grok.com";
const SAFE_RETRY_AFTER = /^\d{1,6}$/u;
const GENERATION_ID_PATTERN = /^gen_[A-Za-z0-9]+$/u;
const CARRIAGE_RETURN_PATTERN = /\r$/u;
const TOOL_TYPE_PATTERN = /tool|function/iu;
const CODEX_VERSION_URL = "https://registry.npmjs.org/@openai/codex/latest";
const GROK_VERSION_URL = "https://x.ai/cli/stable";
const PUBLIC_METADATA_URLS = new Set([
  CODEX_VERSION_URL,
  GATEWAY_MODELS_URL,
  GROK_VERSION_URL,
]);
const CREDENTIAL_HEADERS = [
  "authorization",
  "api-key",
  "chatgpt-account-id",
  "cookie",
  "refresh-token",
  "x-api-key",
  "x-grok-user-id",
  "x-xai-token-auth",
] as const;

function urlOf(input: string): URL {
  try {
    return new URL(input);
  } catch (error) {
    throw new Error("fx transport requires an absolute HTTPS URL", {
      cause: error,
    });
  }
}

function sessionIdOf(headers: Headers): string | null {
  for (const key of FX_SESSION_HEADERS) {
    const value = headers.get(key)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function nativeModel(profile: CodeTaskProfile): string {
  const prefix = `${profile.billing}/`;
  if (!profile.model.startsWith(prefix)) {
    throw new Error(
      `Task ${profile.taskId} has an invalid ${profile.billing} model snapshot`
    );
  }
  return profile.model.slice(prefix.length);
}

function jsonBody(init: RequestInit): Record<string, unknown> {
  const rawBody = init.body;
  let encodedBody: string;
  if (typeof rawBody === "string") {
    encodedBody = rawBody;
  } else if (rawBody instanceof ArrayBuffer) {
    encodedBody = new TextDecoder().decode(rawBody);
  } else if (ArrayBuffer.isView(rawBody)) {
    encodedBody = new TextDecoder().decode(
      new Uint8Array(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
    );
  } else {
    throw new Error("fx model request must have a JSON body");
  }
  const body = JSON.parse(encodedBody) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("fx model request body must be an object");
  }
  return body as Record<string, unknown>;
}

function withBody(
  init: RequestInit,
  body: Record<string, unknown>
): RequestInit {
  return { ...init, body: JSON.stringify(body) };
}

function gatewayBody(
  body: Record<string, unknown>,
  profile: CodeTaskProfile
): Record<string, unknown> {
  if (!profile.fast) {
    return body;
  }
  const existingProviderOptions =
    body.providerOptions &&
    typeof body.providerOptions === "object" &&
    !Array.isArray(body.providerOptions)
      ? (body.providerOptions as Record<string, unknown>)
      : {};
  const gateway =
    existingProviderOptions.gateway &&
    typeof existingProviderOptions.gateway === "object" &&
    !Array.isArray(existingProviderOptions.gateway)
      ? (existingProviderOptions.gateway as Record<string, unknown>)
      : {};
  return {
    ...body,
    providerOptions: {
      ...existingProviderOptions,
      gateway: { ...gateway, serviceTier: "priority" },
    },
  };
}

function modelCatalog(
  access: SubscriptionAccess,
  provider: SubscriptionProvider
): Response {
  return Response.json(
    {
      data: access.models.map((model) => ({
        id: model.id.startsWith(`${provider}/`)
          ? model.id.slice(provider.length + 1)
          : model.id,
        object: "model",
        owned_by: "busy",
      })),
    },
    { headers: { "cache-control": "no-store" } }
  );
}

function subscriptionCatalogProvider(
  url: URL,
  init: RequestInit
): SubscriptionProvider | null {
  if (!isGet(init)) {
    return null;
  }
  if (
    url.origin === CODEX_ORIGIN &&
    url.pathname === "/backend-api/codex/models"
  ) {
    return "chatgpt";
  }
  if (url.origin === GROK_ORIGIN && url.pathname === "/v1/models") {
    return "grok";
  }
  return null;
}

function isModelCatalogRequest(url: URL, init: RequestInit): boolean {
  return (
    isGet(init) &&
    ((GATEWAY_ORIGINS.has(url.origin) &&
      url.pathname === "/coding-agent/v1/models") ||
      subscriptionCatalogProvider(url, init) !== null)
  );
}

function taskHeaders(init: RequestInit): Headers {
  return new Headers(init.headers);
}

function deny(message: string): never {
  throw new Error(`fx provider denied request: ${message}`);
}

async function safeProviderResponse(response: Response): Promise<Response> {
  if (response.ok) {
    return response;
  }
  await response.body?.cancel().catch(() => undefined);
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter && SAFE_RETRY_AFTER.test(retryAfter)) {
    headers.set("retry-after", retryAfter);
  }
  return new Response(
    JSON.stringify({
      error: {
        code: "provider_request_failed",
        status: response.status,
      },
    }),
    { headers, status: response.status }
  );
}

function generationId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 128 &&
    GENERATION_ID_PATTERN.test(value)
    ? value
    : null;
}

function gatewayMetadataGenerationId(
  record: Record<string, unknown>
): string | null {
  const { providerMetadata } = record;
  if (!providerMetadata || typeof providerMetadata !== "object") {
    return null;
  }
  const { gateway } = providerMetadata as Record<string, unknown>;
  if (!gateway || typeof gateway !== "object") {
    return null;
  }
  return generationId((gateway as Record<string, unknown>).generationId);
}

function topLevelGenerationId(record: Record<string, unknown>): string | null {
  const { id, toolCallId, toolName, type } = record;
  if (toolCallId !== undefined || toolName !== undefined) {
    return null;
  }
  if (typeof type === "string" && TOOL_TYPE_PATTERN.test(type)) {
    return null;
  }
  return generationId(id);
}

function nestedGenerationId(record: Record<string, unknown>): string | null {
  for (const key of ["choices", "content", "output", "parts", "response"]) {
    const child = record[key];
    if (!child || typeof child !== "object") {
      continue;
    }
    const found = generationIdFromPayload(child);
    if (found) {
      return found;
    }
  }
  return null;
}

function generationIdFromPayload(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = generationIdFromPayload(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return (
    gatewayMetadataGenerationId(record) ??
    topLevelGenerationId(record) ??
    nestedGenerationId(record)
  );
}

function parseGenerationIdLine(line: string): string | null {
  const value = line.trim();
  if (!value || value === "data: [DONE]") {
    return null;
  }
  const payload = value.startsWith("data:") ? value.slice(5).trim() : value;
  try {
    return generationIdFromPayload(JSON.parse(payload));
  } catch {
    return null;
  }
}

/** Observe AI Gateway's generation metadata while passing the stream byte-for-byte. */
export function observeGatewayGeneration(
  response: Response,
  onGenerationId: (generationId: string) => void | Promise<void>
): Response {
  if (!response.body) {
    return response;
  }
  let buffer = "";
  let captured = false;
  let delivery: Promise<void> | undefined;
  const decoder = new TextDecoder();
  const deliver = (found: string) => {
    captured = true;
    delivery = Promise.resolve(onGenerationId(found)).catch(() => undefined);
    return delivery;
  };
  const inspect = (text: string): Promise<void> | undefined => {
    if (captured) {
      return;
    }
    buffer += text;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer
        .slice(0, newline)
        .replace(CARRIAGE_RETURN_PATTERN, "");
      buffer = buffer.slice(newline + 1);
      const found = parseGenerationIdLine(line);
      if (found) {
        return deliver(found);
      }
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > 131_072) {
      buffer = buffer.slice(-8192);
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async flush() {
        await inspect(decoder.decode());
        if (buffer) {
          const found = parseGenerationIdLine(buffer);
          if (found && !captured) {
            await deliver(found);
          }
        }
        await delivery;
      },
      async transform(chunk, controller) {
        await inspect(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export interface GatewayGenerationInfo {
  gatewayCost: number | null;
  generationId: string;
  marketCost: number | null;
  surchargeCost: number | null;
  totalCost: number;
}

export type GatewayGenerationLookup =
  | { info: GatewayGenerationInfo; status: "ready" }
  | { status: "pending" | "unavailable" };

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function generationData(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const { data } = value as Record<string, unknown>;
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : null;
}

export async function lookupGatewayGeneration(
  profile: CodeTaskProfile,
  id: string,
  dependencies: Pick<
    FxTransportDependencies,
    "fetch" | "getGatewayCredential" | "getTokenPassCredential"
  >
): Promise<GatewayGenerationLookup> {
  if (!GENERATION_ID_PATTERN.test(id)) {
    return { status: "unavailable" };
  }
  const credential =
    profile.billing === "token-pass"
      ? await dependencies.getTokenPassCredential(profile).catch(() => null)
      : await dependencies.getGatewayCredential(profile).catch(() => null);
  if (!credential) {
    return { status: "unavailable" };
  }
  const hostFetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await hostFetch(
      `${GATEWAY_GENERATION_URL}?id=${encodeURIComponent(id)}`,
      {
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(3000),
      }
    );
  } catch {
    return { status: "unavailable" };
  }
  if (response.status === 404) {
    return { status: "pending" };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: "unavailable" };
  }
  const data = generationData(await response.json().catch(() => null));
  if (generationId(data?.id) !== id) {
    return { status: "unavailable" };
  }
  const totalCost = nonNegativeNumber(data?.total_cost);
  if (totalCost === null) {
    return { status: "unavailable" };
  }
  return {
    info: {
      gatewayCost: nonNegativeNumber(data?.gateway_cost),
      generationId: id,
      marketCost: nonNegativeNumber(data?.market_cost),
      surchargeCost: nonNegativeNumber(data?.surcharge_cost),
      totalCost,
    },
    status: "ready",
  };
}

async function publicMetadataRequest(
  url: URL,
  input: string,
  init: RequestInit,
  hostFetch: typeof fetch
): Promise<Response | null> {
  if (!(isGet(init) && PUBLIC_METADATA_URLS.has(url.href))) {
    return null;
  }
  return safeProviderResponse(
    await hostFetch(input, { ...init, headers: new Headers() })
  );
}

async function sessionlessSubscriptionCatalog(
  url: URL,
  init: RequestInit,
  deps: FxTransportDependencies
): Promise<Response | null> {
  const provider = subscriptionCatalogProvider(url, init);
  if (!provider) {
    return null;
  }
  return modelCatalog(await deps.getSubscriptionAccess(provider), provider);
}

function isGet(init: RequestInit): boolean {
  return (init.method ?? "GET").toUpperCase() === "GET";
}

function modelMatches(
  body: Record<string, unknown>,
  profile: CodeTaskProfile,
  native: string
): void {
  if (body.model !== profile.model && body.model !== native) {
    deny("model does not match the task snapshot");
  }
}

function modelAvailable(
  access: SubscriptionAccess,
  profile: CodeTaskProfile,
  native: string
): boolean {
  return access.models.some(
    (model) =>
      model.id === profile.model ||
      model.id === native ||
      model.id === `${profile.billing}/${native}`
  );
}

async function subscriptionRequest(
  provider: SubscriptionProvider,
  url: URL,
  init: RequestInit,
  body: Record<string, unknown> | null,
  profile: CodeTaskProfile,
  deps: FxTransportDependencies,
  hostFetch: typeof fetch
): Promise<Response> {
  const endpoint = `${url.origin}${url.pathname}`;
  const native = nativeModel(profile);
  const nativeOrigin = provider === "chatgpt" ? CODEX_ORIGIN : GROK_ORIGIN;
  const nativeModelsPath =
    provider === "chatgpt" ? "/backend-api/codex/models" : "/v1/models";
  const isNative = url.origin === nativeOrigin;
  const allowed = isNative || endpoint === subscriptionUrl(provider);
  if (!allowed) {
    deny(`${provider} request used the wrong endpoint`);
  }
  const access = await deps.getSubscriptionAccess(provider);
  if (isNative && url.pathname === nativeModelsPath && isGet(init)) {
    return modelCatalog(access, provider);
  }
  if (!body) {
    deny(`${provider} request has no body`);
  }
  modelMatches(body, profile, native);
  if (!modelAvailable(access, profile, native)) {
    deny(`${provider} model is not connected`);
  }
  const prepared = prepareSubscriptionBody(
    provider,
    { ...body, model: native },
    native
  );
  const target = subscriptionUrl(provider);
  return safeProviderResponse(
    await hostFetch(target, {
      ...withBody(init, prepared),
      headers: subscriptionHeaders(provider, access.credentials),
    })
  );
}

async function gatewayRequest(
  input: string,
  init: RequestInit,
  url: URL,
  body: Record<string, unknown> | null,
  profile: CodeTaskProfile,
  deps: FxTransportDependencies,
  hostFetch: typeof fetch
): Promise<Response> {
  if (!GATEWAY_ORIGINS.has(url.origin)) {
    deny("request used an unapproved provider endpoint");
  }
  if (url.pathname === "/coding-agent/v1/models" && isGet(init)) {
    if (!deps.getGatewayModelCatalog) {
      deny("Gateway model catalog is not configured");
    }
    const catalog = await deps.getGatewayModelCatalog(profile);
    return Response.json(catalog, { headers: { "cache-control": "no-store" } });
  }
  if (!body) {
    deny("Gateway request has no body");
  }
  const requestHeaders = new Headers(init.headers);
  const requestedModel =
    requestHeaders.get("ai-language-model-id") ?? body.model;
  if (
    requestedModel !== profile.model ||
    (body.model !== undefined && body.model !== profile.model)
  ) {
    deny("model does not match the task snapshot");
  }
  const credential =
    profile.billing === "token-pass"
      ? await deps.getTokenPassCredential(profile)
      : await deps.getGatewayCredential(profile);
  if (!credential) {
    deny("provider credential unavailable");
  }
  const headers = new Headers(requestHeaders);
  for (const header of CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
  headers.set("authorization", `Bearer ${credential}`);
  const response = await safeProviderResponse(
    await hostFetch(input, {
      ...withBody(init, gatewayBody(body, profile)),
      headers,
    })
  );
  if (!deps.onGenerationId || isGet(init)) {
    return response;
  }
  return observeGatewayGeneration(response, (capturedId) =>
    deps.onGenerationId?.(profile, capturedId)
  );
}

/**
 * Create the host fetch passed to libfx. It validates the task/session before
 * forwarding a request and rewrites only the supported Busy Responses path.
 * No token is stored in fx context, model-visible settings or the sandbox.
 */
function requestForProfile(
  input: string,
  init: RequestInit,
  url: URL,
  body: Record<string, unknown> | null,
  profile: CodeTaskProfile,
  deps: FxTransportDependencies,
  hostFetch: typeof fetch
): Promise<Response> {
  if (profile.billing === "chatgpt" || profile.billing === "grok") {
    return subscriptionRequest(
      profile.billing,
      url,
      init,
      body,
      profile,
      deps,
      hostFetch
    );
  }
  return gatewayRequest(input, init, url, body, profile, deps, hostFetch);
}

function modelCatalogRequest(
  input: string,
  init: RequestInit,
  url: URL,
  body: Record<string, unknown> | null,
  profile: CodeTaskProfile,
  deps: FxTransportDependencies,
  hostFetch: typeof fetch
): Promise<Response> | null {
  if (!isModelCatalogRequest(url, init)) {
    return null;
  }
  return requestForProfile(input, init, url, body, profile, deps, hostFetch);
}

async function observedModelRequest(
  input: string,
  init: RequestInit,
  url: URL,
  body: Record<string, unknown> | null,
  profile: CodeTaskProfile,
  deps: FxTransportDependencies,
  hostFetch: typeof fetch
): Promise<Response> {
  const startedAt = performance.now();
  const requestId = randomUUID();
  observeOperation({
    entryPoint: "workflow",
    flow: "code_task",
    model: profile.model,
    operationId: profile.taskId,
    outcome: "started",
    provider: profile.billing,
    requestId,
    sessionId: profile.sessionId,
    stage: "model",
  });
  try {
    const response = await requestForProfile(
      input,
      init,
      url,
      body,
      profile,
      deps,
      hostFetch
    );
    let outcome: "accepted" | "failed" | "rejected" = "rejected";
    if (response.ok) {
      outcome = "accepted";
    } else if (response.status >= 500) {
      outcome = "failed";
    }
    observeOperation({
      durationMs: performance.now() - startedAt,
      entryPoint: "workflow",
      flow: "code_task",
      httpStatus: response.status,
      model: profile.model,
      operationId: profile.taskId,
      outcome,
      provider: profile.billing,
      requestId,
      sessionId: profile.sessionId,
      stage: "model",
    });
    return response;
  } catch (error) {
    observeOperation({
      durationMs: performance.now() - startedAt,
      entryPoint: "workflow",
      errorCode: operationErrorCode(error),
      flow: "code_task",
      model: profile.model,
      operationId: profile.taskId,
      outcome: "failed",
      provider: profile.billing,
      requestId,
      sessionId: profile.sessionId,
      stage: "model",
    });
    throw error;
  }
}

export function createFxTransport(deps: FxTransportDependencies): FxFetch {
  const hostFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  return async (input, init = {}) => {
    const url = urlOf(input);
    const headers = taskHeaders(init);
    const sessionId = sessionIdOf(headers);
    if (!sessionId) {
      const subscriptionCatalog = await sessionlessSubscriptionCatalog(
        url,
        init,
        deps
      );
      if (subscriptionCatalog) {
        return subscriptionCatalog;
      }
      const metadataResponse = await publicMetadataRequest(
        url,
        input,
        init,
        hostFetch
      );
      if (metadataResponse) {
        return metadataResponse;
      }
      deny("missing task session identity");
    }
    const profile = await deps.lookupTask(sessionId);
    if (!profile || profile.sessionId !== sessionId) {
      deny("unknown task session");
    }

    const body = init.body === undefined ? null : jsonBody(init);
    const catalogResponse = await modelCatalogRequest(
      input,
      init,
      url,
      body,
      profile,
      deps,
      hostFetch
    );
    if (catalogResponse) {
      return catalogResponse;
    }
    return observedModelRequest(
      input,
      init,
      url,
      body,
      profile,
      deps,
      hostFetch
    );
  };
}

/** Assert that the bot snapshot and an fx session profile have not drifted. */
export function assertProfile(
  profile: CodeTaskProfile,
  billing: Billing,
  model: string
): void {
  if (profile.billing !== billing || profile.model !== model) {
    throw new Error("fx task profile changed after session creation");
  }
}
