export const BOT_PROVIDERS = {
  "qa-1104-operaciones-chatgpt": "chatgpt",
  "qa-1104-operaciones-gateway": "gateway",
  "qa-1104-operaciones-grok": "grok",
  "qa-1104-operaciones-tokenpass": "token-pass",
} as const;

export type AllowedBot = keyof typeof BOT_PROVIDERS;

export const DEFAULT_BOTS = Object.keys(BOT_PROVIDERS) as AllowedBot[];

const MESSAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const FAILURE_PHASE_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface ProductionSourceSample {
  bot: AllowedBot;
  messageId: string;
}

export interface ProductionPreflightFailure {
  bot: AllowedBot;
  failureCode: "preflight_failed";
  failurePhase?: string | null;
  messageId: null;
  outcome: "failed";
}

export function isAllowedBot(value: unknown): value is AllowedBot {
  return typeof value === "string" && Object.hasOwn(BOT_PROVIDERS, value);
}

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_PATTERN.test(value);
}

export function isValidSourceSample(
  value: unknown
): value is ProductionSourceSample {
  if (!value || typeof value !== "object") {
    return false;
  }
  const sample = value as { bot?: unknown; messageId?: unknown };
  return isAllowedBot(sample.bot) && isMessageId(sample.messageId);
}

export function isValidPreflightFailure(
  value: unknown
): value is ProductionPreflightFailure {
  if (!value || typeof value !== "object") {
    return false;
  }
  const sample = value as {
    bot?: unknown;
    failureCode?: unknown;
    failurePhase?: unknown;
    messageId?: unknown;
    outcome?: unknown;
  };
  return (
    isAllowedBot(sample.bot) &&
    sample.messageId === null &&
    sample.failureCode === "preflight_failed" &&
    sample.outcome === "failed" &&
    (sample.failurePhase === undefined ||
      sample.failurePhase === null ||
      (typeof sample.failurePhase === "string" &&
        FAILURE_PHASE_PATTERN.test(sample.failurePhase)))
  );
}

export function syntheticPostAllowed(value: unknown): boolean {
  return value === "1";
}
