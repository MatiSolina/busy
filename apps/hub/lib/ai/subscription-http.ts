import { cookies } from "next/headers";
import { z } from "zod";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";
import {
  type AiIssueCode,
  aiIssue,
  issueFromProviderStatus,
  issueResponse,
} from "./errors";
import { validateLoopbackRedirectUri } from "./subscription-protocols";
import type { SubscriptionProvider } from "./subscription-types";

export const subscriptionResponseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

export const subscriptionProvider = z.enum(["chatgpt", "grok"]);
export type SubscriptionProviderParam = z.infer<typeof subscriptionProvider>;

export async function authenticatedUser(): Promise<string | null> {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return process.env.BUSY_USER ?? "dev";
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return null;
  }
  const session = await readSession(
    (await cookies()).get(SESSION_COOKIE)?.value,
    secret
  );
  return session?.user ?? null;
}

export function providerParam(value: string): SubscriptionProvider | null {
  const parsed = subscriptionProvider.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { headers: subscriptionResponseHeaders, status });
}

export function aiJson(
  code: AiIssueCode,
  provider: SubscriptionProvider | null = null,
  status = 500,
  extra: Record<string, unknown> = {}
): Response {
  const issue = aiIssue(code, provider);
  const response = Response.json(
    {
      action: issue.action,
      code: issue.code,
      error: issue.code,
      message: issue.message,
      provider: issue.provider,
      retryable: issue.retryable,
      ...extra,
    },
    { status }
  );
  for (const [key, value] of Object.entries(subscriptionResponseHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export function providerErrorJson(
  status: number,
  provider: SubscriptionProvider,
  code?: AiIssueCode
): Response {
  const issue = code
    ? aiIssue(code, provider)
    : issueFromProviderStatus(status, provider);
  let safeStatus = 502;
  if (issue.code === "provider_rate_limited") {
    safeStatus = 429;
  } else if (
    issue.code === "connection_not_connected" ||
    issue.code === "provider_auth_failed" ||
    issue.code === "provider_access_denied"
  ) {
    safeStatus = 409;
  } else if (status >= 400 && status < 600) {
    safeStatus = status;
  }
  return issueResponse(issue, safeStatus);
}

export async function boundedJson(
  req: Request,
  options: { allowEmpty?: boolean } = {}
): Promise<unknown | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 8 * 1024) {
    return null;
  }
  const text = await req.text();
  if (text.length === 0) {
    return options.allowEmpty ? {} : null;
  }
  if (new TextEncoder().encode(text).byteLength > 8 * 1024) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const completeInput = z
  .object({
    attemptId: z.uuid(),
    callbackUrl: z.string().url().max(2048).optional(),
  })
  .strict();

export const startInput = z
  .object({ redirectUri: z.string().max(256).optional() })
  .strict();

export const cancelInput = z.object({ attemptId: z.uuid() }).strict();

export function loopbackRedirectForRequest(
  request: Request,
  requested?: string
): string | null {
  if (requested) {
    return validateLoopbackRedirectUri(requested);
  }
  const url = URL.parse(request.url);
  if (!(url && ["127.0.0.1", "localhost"].includes(url.hostname) && url.port)) {
    return null;
  }
  return validateLoopbackRedirectUri(
    `http://127.0.0.1:${url.port}/auth/callback`
  );
}
