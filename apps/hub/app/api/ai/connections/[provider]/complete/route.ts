import {
  aiJson,
  authenticatedUser,
  boundedJson,
  cancelInput,
  completeInput,
  json,
} from "@/lib/ai/subscription-http";
import {
  cancelConnectionAttempt,
  completeConnection,
  SubscriptionAttemptNotFoundError,
  SubscriptionPollTooSoonError,
} from "@/lib/ai/subscription-store";
import { SubscriptionConnectionError } from "@/lib/ai/subscription-types";

interface Context {
  params: Promise<{ provider: string }>;
}

const CONNECTION_DECLINED_RE = /declined|denied/iu;
const CONNECTION_EXPIRED_RE = /expired/iu;
const CALLBACK_INVALID_RE = /callback/iu;

function completionErrorCode(
  error: SubscriptionConnectionError
):
  | "access_denied"
  | "connection_expired"
  | "connection_failed"
  | "invalid_callback" {
  if (CONNECTION_DECLINED_RE.test(error.message)) {
    return "access_denied";
  }
  if (CONNECTION_EXPIRED_RE.test(error.message)) {
    return "connection_expired";
  }
  if (CALLBACK_INVALID_RE.test(error.message)) {
    return "invalid_callback";
  }
  return "connection_failed";
}

export async function POST(req: Request, { params }: Context) {
  const user = await authenticatedUser();
  if (!user) {
    return aiJson("unauthorized", null, 401);
  }
  const { provider } = await params;
  if (provider !== "chatgpt" && provider !== "grok") {
    return aiJson("provider_not_found", null, 404);
  }
  const parsed = completeInput.safeParse(await boundedJson(req));
  if (!parsed.success) {
    return aiJson("invalid_data", provider, 400);
  }
  try {
    const result = await completeConnection(provider, user, parsed.data);
    if (result.status === "failed") {
      return aiJson(
        result.code === "access_denied" ? "access_denied" : "connection_failed",
        provider,
        409
      );
    }
    return json(result);
  } catch (error) {
    if (error instanceof SubscriptionAttemptNotFoundError) {
      return aiJson("attempt_not_found", provider, 404);
    }
    if (error instanceof SubscriptionPollTooSoonError) {
      return aiJson("pending", provider, 429, {
        retryAfterMs: error.retryAfterMs,
      });
    }
    if (error instanceof SubscriptionConnectionError) {
      const code = completionErrorCode(error);
      return aiJson(code, provider, code === "invalid_callback" ? 400 : 409);
    }
    return aiJson("connection_failed", provider, 503);
  }
}

export async function DELETE(req: Request, { params }: Context) {
  const user = await authenticatedUser();
  if (!user) {
    return aiJson("unauthorized", null, 401);
  }
  const { provider } = await params;
  if (provider !== "chatgpt" && provider !== "grok") {
    return aiJson("provider_not_found", null, 404);
  }
  const parsed = cancelInput.safeParse(await boundedJson(req));
  if (!parsed.success) {
    return aiJson("invalid_data", provider, 400);
  }
  try {
    await cancelConnectionAttempt(provider, user, parsed.data.attemptId);
    return json({ ok: true });
  } catch (error) {
    if (error instanceof SubscriptionAttemptNotFoundError) {
      return aiJson("attempt_not_found", provider, 404);
    }
    return aiJson("could_not_cancel", provider, 503);
  }
}
