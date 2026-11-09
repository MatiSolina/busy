import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import { getVercelOidcToken } from "@vercel/oidc";
import { wrapLanguageModel } from "ai";

export type SubscriptionProvider = "chatgpt" | "grok";

type SubscriptionLanguageModel = ReturnType<
  ReturnType<typeof createOpenAI>["responses"]
>;
type SubscriptionCallOptions = Parameters<
  SubscriptionLanguageModel["doGenerate"]
>[0];

const TRAILING_SLASH = /\/$/u;
const OPENAI_PROVIDER_METADATA = "openai";
const LEGACY_REPLAY_KEYS = new Set([
  "annotations",
  "async",
  "caller",
  "encryptedContent",
  "itemId",
  "namespace",
  "parallelToolCall",
  "phase",
  "reasoningEncryptedContent",
  "type",
]);
const AUTH =
  /auth|unauthori[sz]|invalid[_ -]?token|token[_ -]?(?:expired|revoked)/u;
const QUOTA = /quota|credit|billing|usage|payment|insufficient/u;
const RATE = /rate[_ -]?limit|too many requests|throttl/u;
const MODEL = /model[_ -]?(?:unavailable|not[_ -]?found)|unsupported/u;
type ErrorCode =
  | "connection_expired"
  | "connection_not_connected"
  | "gateway_unavailable"
  | "invalid_inference_input"
  | "model_unavailable"
  | "provider_access_denied"
  | "provider_auth_failed"
  | "provider_quota_exceeded"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "subscription_auth_required"
  | "subscription_quota_exceeded"
  | "subscription_rate_limited"
  | "subscription_model_unavailable"
  | "subscription_provider_unavailable"
  | "subscription_request_failed"
  | "subscription_not_selected"
  | "unauthorized";
const CANONICAL: Partial<Record<string, ErrorCode>> = {
  connection_expired: "connection_expired",
  connection_not_connected: "connection_not_connected",
  gateway_unavailable: "gateway_unavailable",
  invalid_inference_input: "invalid_inference_input",
  model_unavailable: "model_unavailable",
  provider_access_denied: "provider_access_denied",
  provider_auth_failed: "provider_auth_failed",
  provider_quota_exceeded: "provider_quota_exceeded",
  provider_rate_limited: "provider_rate_limited",
  provider_unavailable: "provider_unavailable",
  subscription_model_unavailable: "subscription_model_unavailable",
  subscription_not_selected: "subscription_not_selected",
  unauthorized: "unauthorized",
};

const providerLabel = (provider: SubscriptionProvider) =>
  provider === "chatgpt" ? "ChatGPT" : "Grok";
const providerMetadataName = (provider: SubscriptionProvider) =>
  `busy-${provider}`;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function scopedProviderOptions(
  value: unknown,
  provider: SubscriptionProvider
): Record<string, unknown> | undefined {
  const options = object(value);
  const legacy = object(options?.[OPENAI_PROVIDER_METADATA]);
  const scoped = object(options?.[providerMetadataName(provider)]);
  const invocation = legacy
    ? Object.fromEntries(
        Object.entries(legacy).filter(([key]) => !LEGACY_REPLAY_KEYS.has(key))
      )
    : {};
  const current = scoped ? { ...scoped } : {};
  const merged = { ...invocation, ...current };
  return Object.keys(merged).length
    ? { [OPENAI_PROVIDER_METADATA]: merged }
    : undefined;
}

function mapPromptRecord(value: unknown, provider: SubscriptionProvider) {
  const record = object(value);
  if (!record) {
    return value;
  }
  if (!("providerOptions" in record)) {
    return { ...record };
  }
  const providerOptions = scopedProviderOptions(
    record.providerOptions,
    provider
  );
  if (providerOptions) {
    return { ...record, providerOptions };
  }
  const { providerOptions: _legacyProviderOptions, ...withoutProviderOptions } =
    record;
  return withoutProviderOptions;
}

function mapPrompt(
  prompt: SubscriptionCallOptions["prompt"],
  provider: SubscriptionProvider
): SubscriptionCallOptions["prompt"] {
  return prompt.map((message) => {
    const next = mapPromptRecord(message, provider) as Record<string, unknown>;
    if (Array.isArray(message.content)) {
      next.content = message.content.map((part) =>
        mapPromptRecord(part, provider)
      );
    }
    return next;
  }) as SubscriptionCallOptions["prompt"];
}

// The hub rejects subscription bodies over 4 MB (Vercel caps function bodies at 4.5 MB), and
// base64 adds a third. 2.4 MB of inline files leaves ~800 KB for the text context.
export const INLINE_FILE_BUDGET = 2_400_000;
const MB = 1_000_000;

function inlineBytes(part: unknown): number {
  const record = object(part);
  const data = object(record?.data);
  if (record?.type !== "file" || data?.type !== "data") {
    return 0;
  }
  if (typeof data.data === "string") {
    return Math.floor((data.data.length * 3) / 4);
  }
  return data.data instanceof Uint8Array ? data.data.byteLength : 0;
}

function omittedFile(part: unknown, bytes: number) {
  const record = object(part);
  const name =
    typeof record?.filename === "string" ? ` ${record.filename}` : "";
  return {
    text: `[${String(record?.mediaType)} file${name} (${(bytes / MB).toFixed(1)} MB) omitted: the request to the model would be too large. To see it, make a smaller copy (for images: JPEG, at most 1280 px wide) and read that.]`,
    type: "text" as const,
  };
}

/**
 * Keeps the newest inline files within `budget` bytes and turns older or oversized ones into a
 * note, so one big screenshot cannot push every later request past the hub's body limit.
 */
export function fitInlineFiles(
  prompt: SubscriptionCallOptions["prompt"],
  budget = INLINE_FILE_BUDGET
): SubscriptionCallOptions["prompt"] {
  let left = budget;
  const keep = (part: unknown) => {
    const bytes = inlineBytes(part);
    if (bytes === 0) {
      return part;
    }
    if (bytes > left) {
      return omittedFile(part, bytes);
    }
    left -= bytes;
    return part;
  };
  const fitPart = (part: unknown) => {
    const record = object(part);
    const output = object(record?.output);
    if (
      record?.type === "tool-result" &&
      output?.type === "content" &&
      Array.isArray(output.value)
    ) {
      // Newest first inside one result too.
      const value = [...output.value].reverse().map(keep).reverse();
      return { ...record, output: { ...output, value } };
    }
    return keep(part);
  };
  return [...prompt]
    .reverse()
    .map((message) =>
      Array.isArray(message.content)
        ? {
            ...message,
            content: [...message.content].reverse().map(fitPart).reverse(),
          }
        : message
    )
    .reverse() as SubscriptionCallOptions["prompt"];
}

function scopedProviderMetadata(
  value: unknown,
  provider: SubscriptionProvider
) {
  const metadata = object(value);
  if (!metadata) {
    return;
  }
  const openai = object(metadata?.[OPENAI_PROVIDER_METADATA]);
  if (!openai) {
    return { ...metadata };
  }
  const { openai: _openai, ...otherMetadata } = metadata;
  return {
    ...otherMetadata,
    [providerMetadataName(provider)]: openai,
  };
}

function mapOutputRecord(value: unknown, provider: SubscriptionProvider) {
  const record = object(value);
  if (!record) {
    return value;
  }
  if (!("providerMetadata" in record)) {
    return { ...record };
  }
  const providerMetadata = scopedProviderMetadata(
    record.providerMetadata,
    provider
  );
  if (providerMetadata) {
    return { ...record, providerMetadata };
  }
  const { providerMetadata: _providerMetadata, ...withoutProviderMetadata } =
    record;
  return withoutProviderMetadata;
}

function namespaceOutput<T>(value: T, provider: SubscriptionProvider): T {
  const record = object(value);
  if (!record) {
    return value;
  }
  const next = mapOutputRecord(record, provider) as Record<string, unknown>;
  if (Array.isArray(record.content)) {
    next.content = record.content.map((part) =>
      mapOutputRecord(part, provider)
    );
  }
  return next as T;
}

function codeFrom(value: unknown): string {
  const root = object(value);
  const nested = object(root?.error) ?? object(object(root?.response)?.error);
  if (typeof root?.code === "string") {
    return root.code.toLowerCase();
  }
  if (typeof root?.error === "string") {
    return root.error.toLowerCase();
  }
  if (typeof nested?.code === "string") {
    return nested.code.toLowerCase();
  }
  return "";
}

function classify(value: unknown, status?: number): ErrorCode {
  const code = codeFrom(value);
  const signal = `${code} ${JSON.stringify(value).slice(0, 4000).toLowerCase()}`;
  const canonical = CANONICAL[code];
  if (canonical) {
    return canonical;
  }
  if (status === 401 || AUTH.test(signal)) {
    return "subscription_auth_required";
  }
  if (status === 402 || QUOTA.test(signal)) {
    return "subscription_quota_exceeded";
  }
  if (status === 429 || RATE.test(signal)) {
    return "subscription_rate_limited";
  }
  if (status === 404 || MODEL.test(signal)) {
    return "subscription_model_unavailable";
  }
  if (status !== undefined && status >= 500) {
    return "subscription_provider_unavailable";
  }
  return "subscription_request_failed";
}

function safeStreamEvent(
  value: unknown,
  provider: SubscriptionProvider
): unknown {
  const root = object(value);
  if (!root) {
    return value;
  }
  const response = object(root.response);
  const kind = typeof root.type === "string" ? root.type.toLowerCase() : "";
  const hasError =
    root.error !== undefined ||
    response?.error !== undefined ||
    kind.includes("error") ||
    kind.includes("failed");
  if (!hasError) {
    return value;
  }
  const safe = {
    code: classify(value),
    message: `${providerLabel(provider)} could not complete this request.`,
    provider,
  };
  const cleanRoot = Object.fromEntries(
    Object.entries(root).filter(
      ([key]) => !["code", "message", "error"].includes(key)
    )
  );
  if (response?.error !== undefined) {
    const cleanResponse = Object.fromEntries(
      Object.entries(response).filter(
        ([key]) => !["code", "message", "error"].includes(key)
      )
    );
    return { ...cleanRoot, response: { ...cleanResponse, error: safe } };
  }

  // Responses API error events use code/message at the event root. Keeping
  // those fields at the root lets the SDK parse the event and preserves its
  // documented streaming contract; only response.failed/nested errors use the
  // nested `error` object above.
  if (kind === "error") {
    return { ...cleanRoot, code: safe.code, message: safe.message };
  }

  return { ...cleanRoot, error: safe };
}

function sanitizeStream(
  body: ReadableStream<Uint8Array>,
  provider: SubscriptionProvider
) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      flush(controller) {
        pending += decoder.decode();
        if (!pending) {
          return;
        }
        const trimmed = pending.trim();
        if (
          trimmed.startsWith("data:") &&
          trimmed.slice(5).trim() !== "[DONE]"
        ) {
          try {
            const payload = JSON.parse(trimmed.slice(5).trim());
            pending = `data: ${JSON.stringify(safeStreamEvent(payload, provider))}`;
          } catch {
            // Keep malformed SSE intact so the SDK reports a safe parse failure.
          }
        }
        controller.enqueue(encoder.encode(`${pending}\n`));
      },
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (
            !trimmed.startsWith("data:") ||
            trimmed.slice(5).trim() === "[DONE]"
          ) {
            controller.enqueue(encoder.encode(`${line}\n`));
            continue;
          }
          try {
            const payload = JSON.parse(trimmed.slice(5).trim());
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(safeStreamEvent(payload, provider))}\n`
              )
            );
          } catch {
            controller.enqueue(encoder.encode(`${line}\n`));
          }
        }
      },
    })
  );
}

async function responseCode(response: Response): Promise<ErrorCode> {
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return classify(body, response.status);
}

function nativeModel(provider: SubscriptionProvider, model: string): string {
  const prefix = `${provider}/`;
  if (!model.startsWith(prefix) || model.length === prefix.length) {
    throw new Error(`Subscription model must use the ${provider}/ prefix.`);
  }
  return model.slice(prefix.length);
}

/** eve's hosted runtime sends subscription calls through Busy's OIDC-authenticated proxy. */
export function subscriptionModel(
  provider: SubscriptionProvider,
  model: string,
  sessionId?: string,
  runtimeHeaders?: Record<string, string>
) {
  const native = nativeModel(provider, model);
  const hub = process.env.HUB_URL?.replace(TRAILING_SLASH, "");
  if (!hub) {
    throw new Error("HUB_URL is required for subscription models.");
  }
  const openai = createOpenAI({
    apiKey: "busy-bot-oidc",
    baseURL: `${hub}/api/bot/ai`,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      for (const [key, value] of Object.entries(runtimeHeaders ?? {})) {
        headers.set(key, value);
      }
      try {
        headers.set("Authorization", `Bearer ${await getVercelOidcToken()}`);
        const response = await fetch(input, { ...init, headers });
        if (response.ok) {
          if (!response.body) {
            return response;
          }
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-length");
          return new Response(sanitizeStream(response.body, provider), {
            headers: responseHeaders,
            status: response.status,
            statusText: response.statusText,
          });
        }
        const error = await responseCode(response);
        return Response.json(
          {
            // @ai-sdk/openai expects the OpenAI-compatible error envelope. Keep
            // only the Busy-owned code/message so provider response bodies never
            // enter Eve's error chain.
            error: {
              code: error,
              message: `${providerLabel(provider)} could not complete this request.`,
              type: "busy_subscription_error",
            },
            provider,
          },
          { status: response.status }
        );
      } catch (error) {
        throw new Error(
          `${providerLabel(provider)} subscription is temporarily unavailable.`,
          { cause: error }
        );
      }
    },
    name: `busy-${provider}`,
  });
  const modelInstance = openai.responses(native);
  // Eve recognizes OpenAI's native provider name for automatic cache affinity.
  // Our replay-safe provider namespaces need the equivalent session key explicitly.
  const promptCacheKey = sessionId
    ? createHash("sha256").update(`${provider}\u0000${sessionId}`).digest("hex")
    : undefined;
  return wrapLanguageModel({
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ params }) => ({
        ...params,
        prompt: fitInlineFiles(mapPrompt(params.prompt, provider)),
        ...(promptCacheKey
          ? {
              providerOptions: {
                ...params.providerOptions,
                openai: {
                  ...params.providerOptions?.openai,
                  promptCacheKey,
                  // GPT-5.6+ cache controls. The hub forwards them only for
                  // canary bots; Grok's proxy is not known to accept them.
                  ...(provider === "chatgpt"
                    ? { promptCacheOptions: { mode: "implicit", ttl: "30m" } }
                    : {}),
                },
              },
            }
          : {}),
      }),
      wrapGenerate: async ({ doGenerate }) =>
        namespaceOutput(await doGenerate(), provider),
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream({
              transform(part, controller) {
                controller.enqueue(namespaceOutput(part, provider));
              },
            })
          ),
        };
      },
    },
    model: modelInstance,
  });
}
