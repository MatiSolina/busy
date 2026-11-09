import { aiIssue, issueFromProviderResponse, issueResponse } from "./errors";
import type {
  SubscriptionCredentials,
  SubscriptionModel,
  SubscriptionProvider,
} from "./subscription-types";

export const SUBSCRIPTION_MAX_BODY_BYTES = 4 * 1024 * 1024;

const CHATGPT_RESPONSES_URL = "https://api.openai.com/v1/responses";
const GROK_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses";
// The subscription proxy rejects inference with HTTP 426 without a supported
// Grok protocol version, even when the same grant can list account models.
const GROK_PROXY_COMPAT_VERSION = "1.0.13";

const BODY_KEYS = new Set([
  "input",
  "instructions",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "text",
  "include",
  "temperature",
  "top_p",
  "max_output_tokens",
  "truncation",
  "metadata",
  "service_tier",
  "prompt_cache_key",
]);
// Only canary bots forward OpenAI's GPT-5.6+ cache controls while we measure
// whether they restore prompt caching for ChatGPT plan requests.
const CHATGPT_CACHE_CANARY_KEYS = new Set(["prompt_cache_options"]);

/** `CHATGPT_CACHE_CANARY` holds comma-separated bot slugs, or `*` for every bot. */
export function chatgptCacheCanary(
  provider: SubscriptionProvider,
  slug: string,
  list = process.env.CHATGPT_CACHE_CANARY
): boolean {
  if (provider !== "chatgpt" || !list) {
    return false;
  }
  const slugs = list.split(",").map((entry) => entry.trim());
  return slugs.includes("*") || slugs.includes(slug);
}

export type ChatgptCachePart = "account" | "options" | "session";
const CACHE_PARTS: readonly ChatgptCachePart[] = [
  "account",
  "options",
  "session",
];

/**
 * Which canary changes apply, from `CHATGPT_CACHE_PARTS` (comma-separated `session`, `account`,
 * `options`; all three when unset). Lets one canary run isolate a part the provider rejects.
 */
export function chatgptCacheParts(
  list = process.env.CHATGPT_CACHE_PARTS
): ReadonlySet<ChatgptCachePart> {
  if (!list) {
    return new Set(CACHE_PARTS);
  }
  const wanted = list.split(",").map((entry) => entry.trim());
  return new Set(CACHE_PARTS.filter((part) => wanted.includes(part)));
}

export function subscriptionUrl(provider: SubscriptionProvider): string {
  return provider === "chatgpt" ? CHATGPT_RESPONSES_URL : GROK_RESPONSES_URL;
}

/** Config model ids are namespaced so a Grok model can never be sent to OpenAI. */
export function nativeSubscriptionModel(
  provider: SubscriptionProvider,
  model: string
): string | null {
  const prefix = `${provider}/`;
  return model.startsWith(prefix) && model.length > prefix.length
    ? model.slice(prefix.length)
    : null;
}

export function hasSubscriptionModel(
  models: readonly SubscriptionModel[],
  provider: SubscriptionProvider,
  model: string
): boolean {
  const namespaced = nativeSubscriptionModel(provider, model);
  if (model.includes("/") && namespaced === null) {
    return false;
  }
  const native = namespaced ?? model;
  return models.some(
    (entry) =>
      entry.id === model ||
      entry.id === native ||
      entry.id === `${provider}/${native}`
  );
}

export function subscriptionHeaders(
  provider: SubscriptionProvider,
  credentials: SubscriptionCredentials,
  cacheCanary?: { promptCacheKey?: unknown }
): Headers {
  const headers = new Headers({
    Accept: "text/event-stream",
    Authorization: `Bearer ${credentials.accessToken}`,
    "Content-Type": "application/json",
  });
  if (provider === "grok") {
    headers.set("X-XAI-Token-Auth", "xai-grok-cli");
    headers.set("x-grok-client-identifier", "busy");
    headers.set("x-grok-client-version", GROK_PROXY_COMPAT_VERSION);
    headers.set("x-grok-user-id", credentials.accountId);
  }
  if (provider === "chatgpt" && cacheCanary) {
    const parts = chatgptCacheParts();
    // eve's own ChatGPT transport sends the cache key as session affinity.
    if (
      parts.has("session") &&
      typeof cacheCanary.promptCacheKey === "string"
    ) {
      headers.set("session-id", cacheCanary.promptCacheKey);
    }
    if (parts.has("account") && credentials.accountId) {
      headers.set("ChatGPT-Account-Id", credentials.accountId);
    }
  }
  return headers;
}

export function responseError(
  status: number,
  code?:
    | "subscription_model_unavailable"
    | "subscription_request_failed"
    | "inference_failed",
  provider: SubscriptionProvider = "chatgpt",
  providerBody?: unknown
): Response {
  const issue = code
    ? aiIssue(code, provider)
    : issueFromProviderResponse(status, providerBody, provider);
  let safeStatus = 502;
  if (issue.code === "provider_rate_limited") {
    safeStatus = 429;
  } else if (issue.code === "provider_quota_exceeded") {
    safeStatus = 402;
  } else if (
    issue.code === "connection_not_connected" ||
    issue.code === "provider_auth_failed" ||
    issue.code === "provider_access_denied" ||
    issue.code === "subscription_model_unavailable"
  ) {
    safeStatus = 409;
  } else if (status >= 400 && status < 500) {
    safeStatus = status;
  }
  const response = issueResponse(issue, safeStatus);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

/** Build the only request shape the hub is willing to forward to a subscription provider. */
export function prepareSubscriptionBody(
  provider: SubscriptionProvider,
  body: unknown,
  model: string,
  cacheCanary = false
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("invalid_body");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.model !== "string" || input.model !== model) {
    throw new Error("invalid_model");
  }
  if (provider === "chatgpt" && input.previous_response_id !== undefined) {
    throw new Error("unsupported_state");
  }
  const result: Record<string, unknown> = { model, store: false, stream: true };
  for (const [key, value] of Object.entries(input)) {
    if (
      key !== "model" &&
      key !== "store" &&
      key !== "stream" &&
      (BODY_KEYS.has(key) ||
        (cacheCanary &&
          CHATGPT_CACHE_CANARY_KEYS.has(key) &&
          chatgptCacheParts().has("options")))
    ) {
      result[key] = value;
    }
  }
  return result;
}

export function streamHeaders(contentType = "text/event-stream"): Headers {
  return new Headers({
    "Cache-Control": "no-store, no-transform",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}
