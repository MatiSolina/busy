import { createHash } from "node:crypto";
import {
  type AiIssueCode,
  aiIssue,
  issueFromError,
  issueFromProviderResponse,
  issueResponse,
} from "@/lib/ai/errors";
import {
  chatgptCacheCanary,
  chatgptCacheParts,
  hasSubscriptionModel,
  nativeSubscriptionModel,
  prepareSubscriptionBody,
  responseError,
  SUBSCRIPTION_MAX_BODY_BYTES,
  streamHeaders,
  subscriptionHeaders,
  subscriptionUrl,
} from "@/lib/ai/inference";
import { observeStream } from "@/lib/ai/stream-usage";
import {
  getSubscriptionAccess,
  invalidateSubscriptionAccess,
} from "@/lib/ai/subscription-store";
import type {
  SubscriptionCredentials,
  SubscriptionModel,
  SubscriptionProvider,
} from "@/lib/ai/subscription-types";
import { SubscriptionConnectionError } from "@/lib/ai/subscription-types";
import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { logChatObservation, requestIdOf } from "@/lib/chat/observability";
import { countModelRequest, runtimeParticipant } from "@/lib/firesides/auth";
import { type Stages, span, stageFields } from "@/lib/trace";

export const maxDuration = 800;
const MAX_PROVIDER_ERROR_BYTES = 16 * 1024;

const providerOf = (billing: unknown): SubscriptionProvider | null =>
  billing === "chatgpt" || billing === "grok" ? billing : null;

function accessIssue(error: unknown, provider: SubscriptionProvider) {
  if (!(error instanceof SubscriptionConnectionError)) {
    return issueFromError(error, provider, "provider_unavailable");
  }
  let code:
    | "access_denied"
    | "connection_expired"
    | "connection_not_connected"
    | "provider_unavailable" = "provider_unavailable";
  if (error.code === "connection_not_connected") {
    code = "connection_not_connected";
  } else if (error.code === "connection_expired") {
    code = "connection_expired";
  } else if (error.code === "access_denied") {
    code = "access_denied";
  }
  return aiIssue(code, provider);
}

interface SubscriptionAccess {
  credentials: SubscriptionCredentials;
  models: SubscriptionModel[];
}

async function readJson(req: Request): Promise<unknown> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > SUBSCRIPTION_MAX_BODY_BYTES) {
    throw new Error("payload_too_large");
  }
  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > SUBSCRIPTION_MAX_BODY_BYTES) {
    throw new Error("payload_too_large");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readProviderErrorBody(response: Response): Promise<unknown> {
  const { body } = response;
  if (!body) {
    return null;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  try {
    while (byteLength <= MAX_PROVIDER_ERROR_BYTES) {
      // The reader must be consumed sequentially to enforce the response-size cap.
      // biome-ignore lint/performance/noAwaitInLoops: bounded stream reads are intentionally sequential
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_PROVIDER_ERROR_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text) as unknown;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}

function invalidBody(error: unknown): Response {
  const tooLarge =
    error instanceof Error && error.message === "payload_too_large";
  return issueResponse(
    aiIssue(tooLarge ? "payload_too_large" : "invalid_inference_input"),
    tooLarge ? 413 : 400
  );
}

function requestBody(
  provider: SubscriptionProvider,
  body: unknown,
  native: string,
  cacheCanary: boolean
): Record<string, unknown> | Response {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as Record<string, unknown>).model !== native
  ) {
    return issueResponse(aiIssue("model_unavailable", provider), 400);
  }
  try {
    return prepareSubscriptionBody(provider, body, native, cacheCanary);
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_body";
    const issueCode: AiIssueCode =
      code === "invalid_model"
        ? "model_unavailable"
        : "invalid_inference_input";
    return issueResponse(
      aiIssue(issueCode, provider),
      code === "invalid_model" || code === "invalid_body" ? 400 : 422
    );
  }
}

async function forwardSubscription(
  req: Request,
  provider: SubscriptionProvider,
  access: SubscriptionAccess,
  body: Record<string, unknown>,
  cacheCanary: boolean,
  observe: (fields: Record<string, number | string | undefined>) => void
): Promise<Response> {
  const sentAt = performance.now();
  try {
    const upstream = await fetch(subscriptionUrl(provider), {
      body: JSON.stringify(body),
      headers: subscriptionHeaders(
        provider,
        access.credentials,
        cacheCanary ? { promptCacheKey: body.prompt_cache_key } : undefined
      ),
      method: "POST",
      redirect: "error",
      signal: req.signal,
    });
    const upstreamMs = Math.round(performance.now() - sentAt);
    if (!(upstream.ok && upstream.body)) {
      const providerBody = await readProviderErrorBody(upstream);
      observe({
        outcome: "failed",
        status: upstream.status,
        upstreamMs,
        ...providerErrorFields(providerBody),
      });
      const issue = issueFromProviderResponse(
        upstream.status,
        providerBody,
        provider
      );
      if (
        upstream.status === 401 &&
        (issue.code === "connection_not_connected" ||
          issue.code === "provider_auth_failed")
      ) {
        await invalidateSubscriptionAccess(provider, access.credentials).catch(
          () => false
        );
      }
      return responseError(upstream.status, undefined, provider, providerBody);
    }
    const observed = observeStream(upstream.body, (timing) =>
      observe({
        ...timing.usage,
        firstChunkMs: timing.firstChunkMs,
        outcome: "completed",
        status: upstream.status,
        streamMs: timing.streamMs,
        upstreamMs,
      })
    );
    return new Response(observed, {
      headers: streamHeaders(upstream.headers.get("content-type") ?? undefined),
      status: upstream.status,
    });
  } catch {
    observe({ outcome: "failed", status: 502 });
    return responseError(502, undefined, provider);
  }
}

const PROVIDER_LABEL = /^[A-Za-z0-9._:-]{1,64}$/u;

/** OpenAI-style `error.code`/`error.param`: identifiers only, never the message text. */
function providerErrorFields(body: unknown) {
  const error =
    body && typeof body === "object" && "error" in body
      ? (
          body as {
            error?: { code?: unknown; param?: unknown; type?: unknown };
          }
        ).error
      : undefined;
  const label = (value: unknown) =>
    typeof value === "string" && PROVIDER_LABEL.test(value) ? value : undefined;
  return {
    providerErrorCode: label(error?.code) ?? label(error?.type),
    providerErrorParam: label(error?.param),
  };
}

const bytes = (value: unknown) =>
  value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value));

/** 12 hex chars of SHA-256: equal across calls when the content is, and reveals nothing else. */
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex")
    .slice(0, 12);

/**
 * Where the prompt's size comes from, as counts and byte sizes only, plus digests of the parts a
 * provider's prompt cache matches on: a stable prefix with zero cached tokens is the provider's.
 */
function requestShape(body: Record<string, unknown>) {
  const input = Array.isArray(body.input) ? body.input : [body.input];
  return {
    headDigest: digest([body.tools, body.instructions, input[0]]),
    // A fixed-length history prefix: equal between consecutive calls of one session that both
    // carry at least this many items, if the history is replayed byte for byte.
    historyDigest: input.length >= 64 ? digest(input.slice(0, 64)) : undefined,
    inputBytes: bytes(body.input),
    inputItems: Array.isArray(body.input) ? body.input.length : 1,
    instructionsBytes: bytes(body.instructions),
    // What the bot asked for; `serviceTier` is what the provider served.
    requestedTier:
      typeof body.service_tier === "string" ? body.service_tier : undefined,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    toolsBytes: bytes(body.tools),
  };
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const stages: Stages = {};
  const caller = await span("ai.auth", () => botFromRequest(req), stages);
  if (caller instanceof Response) {
    return caller;
  }
  const sourceBot = await span("ai.bot", () => getBot(caller.slug), stages);
  if (!sourceBot) {
    return issueResponse(aiIssue("not_found"), 404);
  }
  const firesideRequest = req.headers.has("x-busy-fireside-id");
  const runtime = firesideRequest
    ? await runtimeParticipant(req, caller.slug)
    : null;
  if (firesideRequest && !runtime) {
    return issueResponse(aiIssue("access_denied"), 403);
  }
  const bot = runtime
    ? {
        ...sourceBot,
        billing: runtime.participant.billing,
        model: runtime.participant.model,
      }
    : sourceBot;
  const provider = providerOf(bot.billing);
  if (!provider) {
    return issueResponse(aiIssue("subscription_not_selected"), 409);
  }

  let body: unknown;
  try {
    body = await readJson(req);
  } catch (error) {
    return invalidBody(error);
  }

  const native = nativeSubscriptionModel(provider, bot.model);
  if (!native) {
    return issueResponse(aiIssue("model_unavailable", provider), 409);
  }
  const cacheCanary = chatgptCacheCanary(provider, caller.slug);
  const prepared = requestBody(provider, body, native, cacheCanary);
  if (prepared instanceof Response) {
    return prepared;
  }
  // Existing bot deployments do not send a cache key yet. Their persisted root
  // session provides affinity immediately; newer runtimes identify child sessions too.
  if (prepared.prompt_cache_key === undefined && bot.sessionId) {
    prepared.prompt_cache_key = createHash("sha256")
      .update(`${provider}\u0000${bot.sessionId}`)
      .digest("hex");
  }
  let access: SubscriptionAccess;
  try {
    access = await span(
      "ai.access",
      () => getSubscriptionAccess(provider, { stages }),
      stages
    );
  } catch (error) {
    const issue = accessIssue(error, provider);
    return issueResponse(
      issue,
      issue.code === "connection_not_connected" ||
        issue.code === "connection_expired" ||
        issue.code === "access_denied"
        ? 409
        : 503
    );
  }
  if (!hasSubscriptionModel(access.models, provider, bot.model)) {
    return responseError(403, "subscription_model_unavailable", provider);
  }
  if (
    runtime &&
    !(await countModelRequest(
      runtime.row.id,
      runtime.participant.id,
      runtime.sessionId,
      runtime.revision
    ))
  ) {
    return issueResponse(aiIssue("provider_rate_limited", provider), 429);
  }
  // Hub overhead before the provider sees the request, then the provider's own timing and usage.
  const requestId = requestIdOf(req);
  const setupMs = Date.now() - startedAt;
  const shape = requestShape(prepared);
  return forwardSubscription(
    req,
    provider,
    access,
    prepared,
    cacheCanary,
    (fields) =>
      logChatObservation("ai.response", {
        botSlug: caller.slug,
        cacheCanary,
        cacheParts: cacheCanary
          ? [...chatgptCacheParts()].join(".")
          : undefined,
        durationMs: setupMs,
        provider,
        requestId,
        ...stageFields(stages),
        ...shape,
        ...fields,
      })
  );
}
