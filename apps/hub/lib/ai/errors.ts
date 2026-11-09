import type { Billing } from "../bots/models";

/** Stable, public error codes shared by AI settings, connection and inference routes. */
export type AiIssueCode =
  | "access_denied"
  | "attempt_not_found"
  | "chatgpt_desktop_required"
  | "connection_failed"
  | "connection_expired"
  | "connection_not_connected"
  | "context_length_exceeded"
  | "deployment_failed"
  | "could_not_cancel"
  | "could_not_disconnect"
  | "could_not_load"
  | "could_not_save"
  | "could_not_start_connection"
  | "gateway_unavailable"
  | "inference_failed"
  | "invalid_callback"
  | "invalid_data"
  | "invalid_inference_input"
  | "invalid_model"
  | "invalid_redirect_uri"
  | "message_delivery_failed"
  | "model_unavailable"
  | "not_found"
  | "payload_too_large"
  | "pending"
  | "provider_not_found"
  | "provider_access_denied"
  | "provider_auth_failed"
  | "provider_quota_exceeded"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_unconfigured"
  | "subscription_model_unavailable"
  | "subscription_not_selected"
  | "subscription_request_failed"
  | "unauthorized";

export type AiIssueProvider = Billing | null;

/** The UI action associated with a recoverable AI exception. */
export type AiIssueAction =
  | "bot-settings"
  | "contact-owner"
  | "retry"
  | "settings"
  | "sign-in"
  | "usage";

export interface AiIssue {
  action: AiIssueAction;
  code: AiIssueCode;
  message: string;
  provider: AiIssueProvider;
  retryable: boolean;
}

const providerName = (provider: AiIssueProvider): string => {
  if (provider === "chatgpt") {
    return "ChatGPT";
  }
  if (provider === "grok") {
    return "Grok";
  }
  if (provider === "gateway") {
    return "AI Gateway";
  }
  if (provider === "token-pass") {
    return "Token Pass";
  }
  return "AI provider";
};

const defaults = (
  code: AiIssueCode,
  provider: AiIssueProvider
): Omit<AiIssue, "code" | "provider"> => {
  const name = providerName(provider);
  switch (code) {
    case "access_denied":
      return {
        action: "settings",
        message: `${name} denied the connection.`,
        retryable: false,
      };
    case "attempt_not_found":
      return {
        action: "settings",
        message: "The connection window expired. Start it again.",
        retryable: false,
      };
    case "connection_expired":
      return {
        action: "settings",
        message: `Your ${name} connection expired. Reconnect it in Settings.`,
        retryable: false,
      };
    case "chatgpt_desktop_required":
      return {
        action: "sign-in",
        message: "ChatGPT connections require the Busy desktop app.",
        retryable: false,
      };
    case "connection_failed":
      return {
        action: "settings",
        message: `Busy could not finish the ${name} connection.`,
        retryable: true,
      };
    case "connection_not_connected":
      return {
        action: "settings",
        message: `Your ${name} connection is no longer available.`,
        retryable: false,
      };
    case "context_length_exceeded":
      return {
        action: "retry",
        message: "This conversation is too long for the model.",
        retryable: false,
      };
    case "deployment_failed":
      return {
        action: "retry",
        message: "Busy could not deploy this bot.",
        retryable: true,
      };
    case "could_not_cancel":
      return {
        action: "retry",
        message: "Busy could not cancel that connection attempt.",
        retryable: true,
      };
    case "could_not_disconnect":
      return {
        action: "retry",
        message: `Busy could not disconnect ${name}.`,
        retryable: true,
      };
    case "could_not_load":
      return {
        action: "retry",
        message: "Busy could not load AI connection settings.",
        retryable: true,
      };
    case "could_not_save":
      return {
        action: "retry",
        message: "Busy could not save AI connection settings.",
        retryable: true,
      };
    case "could_not_start_connection":
      return {
        action: "retry",
        message: `Busy could not start the ${name} connection.`,
        retryable: true,
      };
    case "gateway_unavailable":
      return {
        action: "retry",
        message: "AI Gateway is unavailable right now.",
        retryable: true,
      };
    case "inference_failed":
    case "subscription_request_failed":
      return {
        action: "retry",
        message: `${name} could not complete the request.`,
        retryable: true,
      };
    case "invalid_callback":
      return {
        action: "sign-in",
        message: "That callback URL is not valid.",
        retryable: false,
      };
    case "invalid_data":
      return {
        action: "retry",
        message: "The information sent to Busy is invalid.",
        retryable: false,
      };
    case "invalid_inference_input":
      return {
        action: "retry",
        message:
          "That message could not be sent because its request was invalid.",
        retryable: false,
      };
    case "invalid_model":
    case "model_unavailable":
    case "subscription_model_unavailable":
      return {
        action: "bot-settings",
        message: "That model is not available for this AI connection.",
        retryable: false,
      };
    case "invalid_redirect_uri":
      return {
        action: "sign-in",
        message: "That callback address is not valid.",
        retryable: false,
      };
    case "message_delivery_failed":
      return {
        action: "retry",
        message: "Busy could not send this message.",
        retryable: true,
      };
    case "not_found":
      return {
        action: "retry",
        message: "The requested Busy resource was not found.",
        retryable: false,
      };
    case "payload_too_large":
      return {
        action: "retry",
        message: "That request is too large to send.",
        retryable: false,
      };
    case "pending":
      return {
        action: "sign-in",
        message: "Waiting for approval from the provider.",
        retryable: true,
      };
    case "provider_not_found":
      return {
        action: "settings",
        message: "That AI connection is not supported.",
        retryable: false,
      };
    case "provider_access_denied":
      return {
        action:
          provider === "gateway" || provider === "token-pass"
            ? "contact-owner"
            : "settings",
        message: `${name} does not allow this request for the selected connection.`,
        retryable: false,
      };
    case "provider_auth_failed":
      return {
        action:
          provider === "gateway" || provider === "token-pass"
            ? "contact-owner"
            : "settings",
        message: `Busy could not authenticate with ${name}.`,
        retryable: false,
      };
    case "provider_quota_exceeded":
      return {
        action: "usage",
        message: `${name} has no remaining allowance for this request.`,
        retryable: false,
      };
    case "provider_rate_limited":
      return {
        action: "retry",
        message: `${name} is busy right now.`,
        retryable: true,
      };
    case "provider_unavailable":
      return {
        action: "retry",
        message: `${name} is unavailable right now.`,
        retryable: true,
      };
    case "provider_unconfigured":
      return {
        action: "settings",
        message: `${name} is not configured for this Busy account.`,
        retryable: false,
      };
    case "subscription_not_selected":
      return {
        action: "settings",
        message: "This bot does not have a subscription connection selected.",
        retryable: false,
      };
    case "unauthorized":
      return {
        action: "sign-in",
        message: "Your Busy session expired.",
        retryable: false,
      };
    default:
      throw new Error(`Unsupported AI issue code: ${code}`);
  }
};

export function aiIssue(
  code: AiIssueCode,
  provider: AiIssueProvider = null,
  overrides: Partial<Omit<AiIssue, "code" | "provider">> = {}
): AiIssue {
  return { code, provider, ...defaults(code, provider), ...overrides };
}

/** Human-facing guidance for clients that render the compact action enum. */
export function aiIssueGuidance(
  issue: Pick<AiIssue, "action" | "code"> & Partial<Pick<AiIssue, "provider">>
): string {
  if (
    issue.code === "provider_quota_exceeded" &&
    (issue.provider === "gateway" || issue.provider === "token-pass")
  ) {
    return "Ask the Busy account owner to check the Vercel allowance and spending limits.";
  }
  if (issue.code === "invalid_inference_input") {
    return "Try a shorter message or fewer files. If it still fails, choose another model in this bot's settings.";
  }
  if (issue.code === "context_length_exceeded") {
    return "Start a fresh conversation or ask for a shorter task before trying again.";
  }
  if (issue.code === "model_unavailable") {
    return "Choose another model in this bot's settings.";
  }
  if (issue.code === "unauthorized") {
    return "Sign in to Busy again, then try again.";
  }
  if (issue.code === "chatgpt_desktop_required") {
    return "Open Busy for Mac and start the ChatGPT connection there.";
  }
  if (issue.code === "pending") {
    return "Approve the connection in the provider window.";
  }
  if (issue.code === "invalid_callback") {
    return "Restart the connection and copy the full callback URL from Busy.";
  }
  switch (issue.action) {
    case "bot-settings":
      return "Open this bot's settings and choose another model.";
    case "contact-owner":
      return "Ask the Busy account owner to configure this AI connection.";
    case "retry":
      return "Try again in a moment.";
    case "settings":
      return "Open AI connection settings to reconnect or choose another provider.";
    case "sign-in":
      return "Sign in or reconnect the provider, then try again.";
    case "usage":
      return "Check the provider's usage page or choose another AI connection.";
    default:
      return "Try again or open AI connection settings.";
  }
}

/** An Error carrying a safe, serializable Busy issue. */
export class AiIssueError extends Error {
  readonly issue: AiIssue;
  readonly status: number;

  constructor(issue: AiIssue, status = 503, cause?: unknown) {
    super(issue.message, { cause });
    this.name = "AiIssueError";
    this.issue = issue;
    this.status = status;
  }
}

/** Convert a safe issue to a public JSON response. */
export function issueResponse(
  issue: AiIssue,
  status = 500,
  legacy = false
): Response {
  if (legacy) {
    return Response.json({ error: issue.code }, { status });
  }
  return Response.json(
    {
      action: issue.action,
      code: issue.code,
      error: issue.code,
      message: issue.message,
      provider: issue.provider,
      retryable: issue.retryable,
    },
    { status }
  );
}

const ISSUE_CODES = new Set<AiIssueCode>([
  "access_denied",
  "attempt_not_found",
  "chatgpt_desktop_required",
  "connection_failed",
  "connection_expired",
  "connection_not_connected",
  "context_length_exceeded",
  "deployment_failed",
  "could_not_cancel",
  "could_not_disconnect",
  "could_not_load",
  "could_not_save",
  "could_not_start_connection",
  "gateway_unavailable",
  "inference_failed",
  "invalid_callback",
  "invalid_data",
  "invalid_inference_input",
  "invalid_model",
  "invalid_redirect_uri",
  "message_delivery_failed",
  "model_unavailable",
  "not_found",
  "payload_too_large",
  "pending",
  "provider_not_found",
  "provider_access_denied",
  "provider_auth_failed",
  "provider_quota_exceeded",
  "provider_rate_limited",
  "provider_unavailable",
  "provider_unconfigured",
  "subscription_model_unavailable",
  "subscription_not_selected",
  "subscription_request_failed",
  "unauthorized",
]);

const RESPONSE_CODE_ALIASES = new Map<string, AiIssueCode>([
  ["offline", "provider_unavailable"],
  ["provider_auth_required", "provider_auth_failed"],
  ["quota_exceeded", "provider_quota_exceeded"],
  ["rate_limited", "provider_rate_limited"],
]);

export function issueFromError(
  error: unknown,
  provider: AiIssueProvider = null,
  fallback: AiIssueCode = "provider_unavailable"
): AiIssue {
  if (error instanceof AiIssueError) {
    return error.issue;
  }
  if (error instanceof Error && ISSUE_CODES.has(error.message as AiIssueCode)) {
    return aiIssue(error.message as AiIssueCode, provider);
  }
  return aiIssue(fallback, provider);
}

/**
 * Classify a provider status without reading its response body. Provider
 * bodies can contain account data and must never be forwarded to the browser.
 */
export function issueFromProviderStatus(
  status: number,
  provider: AiIssueProvider,
  origin: "busy" | "provider" = "provider"
): AiIssue {
  if (origin === "busy" && status === 401) {
    return aiIssue("unauthorized");
  }
  if (status === 401) {
    return aiIssue(
      provider === "chatgpt" || provider === "grok"
        ? "connection_not_connected"
        : "provider_auth_failed",
      provider
    );
  }
  if (status === 403) {
    return aiIssue("provider_access_denied", provider);
  }
  if (status === 402) {
    return aiIssue("provider_quota_exceeded", provider);
  }
  if (status === 408 || status === 425 || status === 429) {
    return aiIssue("provider_rate_limited", provider);
  }
  if (status === 404 && (provider === "chatgpt" || provider === "grok")) {
    return aiIssue("model_unavailable", provider);
  }
  if (status >= 400 && status < 500) {
    return aiIssue("invalid_inference_input", provider);
  }
  return aiIssue("provider_unavailable", provider);
}

const PROVIDER_CODE_ISSUES = new Map<string, AiIssueCode>([
  ["subscription_sharing_usage_limit_exceeded", "provider_quota_exceeded"],
  ["insufficient_quota", "provider_quota_exceeded"],
  ["quota_exceeded", "provider_quota_exceeded"],
  ["quota_for_entity_exceeded", "provider_quota_exceeded"],
  ["subscription_sharing_usage_unavailable", "provider_unavailable"],
  ["subscription_sharing_user_not_eligible", "provider_access_denied"],
  ["subscription_sharing_route_not_supported", "provider_access_denied"],
  ["subscription_sharing_invalid_user", "connection_not_connected"],
  ["subscription_sharing_unsupported_capability", "invalid_inference_input"],
  ["rate_limit_exceeded", "provider_rate_limited"],
]);

function providerErrorCodes(body: unknown): Set<string> {
  if (!body || typeof body !== "object") {
    return new Set();
  }
  const root = body as Record<string, unknown>;
  const values = new Set<string>();
  for (const key of ["code", "type", "error"]) {
    const value = root[key];
    if (typeof value === "string") {
      values.add(value);
    }
    if (value && typeof value === "object") {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of ["code", "type"]) {
        const nestedValue = nested[nestedKey];
        if (typeof nestedValue === "string") {
          values.add(nestedValue);
        }
      }
    }
  }
  return values;
}

/** Classify a bounded provider error payload by code/type only. */
export function issueFromProviderResponse(
  status: number,
  body: unknown,
  provider: AiIssueProvider
): AiIssue {
  const issueCode = [...providerErrorCodes(body)].find((code) =>
    PROVIDER_CODE_ISSUES.has(code)
  );
  if (issueCode) {
    const mapped = PROVIDER_CODE_ISSUES.get(issueCode);
    if (mapped) {
      return aiIssue(mapped, provider);
    }
  }
  return issueFromProviderStatus(status, provider);
}

/** Parse an API response body into the same safe issue shape used by routes. */
export function aiIssueFromResponse(
  body: unknown,
  options: {
    origin?: "busy" | "provider";
    provider?: AiIssueProvider;
    status?: number;
  } = {}
): AiIssue | null {
  if (!body || typeof body !== "object") {
    if (options.origin !== "provider" && options.status === 401) {
      return aiIssue("unauthorized");
    }
    return null;
  }
  const input = body as Record<string, unknown>;
  const rawCode = input.code ?? input.error;
  const code =
    typeof rawCode === "string"
      ? (RESPONSE_CODE_ALIASES.get(rawCode) ?? rawCode)
      : null;
  if (typeof code !== "string" || !ISSUE_CODES.has(code as AiIssueCode)) {
    if (options.origin !== "provider" && options.status === 401) {
      return aiIssue("unauthorized");
    }
    return null;
  }
  // The server owns the message/action copy. Never let provider or arbitrary
  // API response text override the fixed Busy vocabulary. Callers should pass
  // the bot/account provider when it is known.
  const inputProvider =
    input.provider === "chatgpt" ||
    input.provider === "grok" ||
    input.provider === "gateway" ||
    input.provider === "token-pass"
      ? (input.provider as Billing)
      : null;
  return aiIssue(code as AiIssueCode, options.provider ?? inputProvider);
}

/** Keep legacy bot rows from reflecting an arbitrary provider/Vercel error. */
export function sanitizeAiMessage(
  value: unknown,
  fallback = "Busy could not deploy this bot."
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  if (value === "The deploy failed. Check the build in Vercel.") {
    return value;
  }
  const providers: AiIssueProvider[] = [
    null,
    "chatgpt",
    "grok",
    "token-pass",
    "gateway",
  ];
  for (const provider of providers) {
    for (const code of ISSUE_CODES) {
      if (aiIssue(code, provider).message === value) {
        return value;
      }
    }
  }
  return fallback;
}

const SAFE_ROUTINE_LEGACY_MESSAGES = new Set([
  "The routine delivery was not accepted.",
  "The bot session ended before this routine could finish. Check the chat.",
  "The bot session is no longer available; this routine result could not be verified. Check the chat before running it again.",
  "The routine was cancelled.",
]);

/**
 * Keep persisted routine results safe when they are rendered much later. The
 * monitor appends a compact action sentence to the fixed issue message; this
 * allowlist accepts that sentence and hides legacy provider payloads.
 */
export function sanitizeAiRoutineMessage(
  value: unknown,
  fallback = "The last run failed. Check this bot's chat for details."
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "string") {
    return fallback;
  }
  if (SAFE_ROUTINE_LEGACY_MESSAGES.has(value)) {
    return value;
  }
  const routineGuidance = (issue: AiIssue): string => {
    switch (issue.action) {
      case "bot-settings":
        return "Choose a supported model in bot Settings.";
      case "contact-owner":
        return "Ask the Busy administrator to check this connection.";
      case "retry":
        return "Try again in a moment.";
      case "settings":
        return "Reconnect it in Settings.";
      case "sign-in":
        return "Sign in again and retry.";
      case "usage":
        return "Check usage or choose another AI connection in Settings.";
      default:
        return "Try again in a moment.";
    }
  };
  const providers: AiIssueProvider[] = [
    null,
    "chatgpt",
    "grok",
    "token-pass",
    "gateway",
  ];
  for (const provider of providers) {
    for (const code of ISSUE_CODES) {
      const issue = aiIssue(code, provider);
      for (const guidance of [routineGuidance(issue), aiIssueGuidance(issue)]) {
        if (`${issue.message} ${guidance}` === value) {
          return value;
        }
      }
    }
  }
  return fallback;
}
