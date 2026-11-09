import {
  type AiIssue,
  aiIssue,
  aiIssueFromResponse,
  aiIssueGuidance,
} from "../ai/errors";
import type { Billing } from "../bots/models";

export type { AiIssue } from "../ai/errors";

type ModelIssueCode =
  | "auth_required"
  | "quota_exceeded"
  | "rate_limited"
  | "provider_unavailable"
  | "model_unavailable"
  | "context_length"
  | "invalid_request"
  | "unknown";

const PROVIDERS = new Set<Billing>([
  "token-pass",
  "gateway",
  "chatgpt",
  "grok",
]);
const STATUS_PATTERN = /^\d{3}$/u;
const AUTH_PATTERN =
  /subscription_(?:not_selected|not_connected|expired|auth|required)|unauthori[sz]|invalid[_ -]?api[_ -]?key|token[_ -]?(?:expired|revoked|invalid)|reauth|\b401\b/u;
const MODEL_PATTERN =
  /model[_ -]?(?:unavailable|not[_ -]?found|unsupported)|unknown[_ -]?model|does not exist/u;
const CONTEXT_PATTERN =
  /context[_ -]?(?:length|window)|maximum.{0,24}(?:context|tokens)|too many tokens|prompt is too long|input is too long/u;
const QUOTA_PATTERN =
  /quota|credit|billing|insufficient[_ -]?funds|usage[_ -]?(?:limit|exceeded)|payment[_ -]?required/u;
const RATE_PATTERN = /rate[_ -]?limit|too many requests|throttl/u;
const OUTAGE_PATTERN =
  /provider[_ -]?(?:unavailable|failed)|service[_ -]?unavailable|temporar|timeout|timed out|network|failed to fetch|gateway/u;
const INPUT_PATTERN =
  /invalid[_ -]?(?:body|request|input)|unsupported[_ -]?(?:state|parameter|feature)|payload[_ -]?too[_ -]?large/u;
const CONTEXT_SIGNAL_PATTERN =
  /context[_ -]?(?:length|window)|maximum.{0,24}(?:context|tokens)|too many tokens|prompt is too long|input is too long/u;
const FORBIDDEN_QUOTA_PATTERN =
  /quota|credit|billing|usage|payment|insufficient/u;
const FORBIDDEN_AUTH_PATTERN = /auth|token|credential|permission/u;
const PROVIDER_SIGNAL_PATTERN =
  /api|provider|gateway|token|quota|credit|rate|model|subscription|auth|http\s*[45]\d\d|responsebody|apicallerror/u;
const CANONICAL_SIGNAL_PATTERN =
  /connection_(?:not_connected|expired|failed)|context_length_exceeded|provider_|subscription_|unauthorized|model_unavailable|invalid_inference_input/u;
const MAX_ERROR_UNWRAP_DEPTH = 3;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorRecords(
  value: unknown,
  depth = 0,
  seen = new Set<object>()
): Record<string, unknown>[] {
  const record = object(value);
  if (!record || depth > MAX_ERROR_UNWRAP_DEPTH || seen.has(record)) {
    return [];
  }
  seen.add(record);
  const records = [record];
  for (const key of ["issue", "data", "lastError", "cause", "error"]) {
    records.push(...errorRecords(record[key], depth + 1, seen));
  }
  if (Array.isArray(record.errors)) {
    records.push(...errorRecords(record.errors.at(-1), depth + 1, seen));
  }
  return records;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 2000).toLowerCase() : "";
}

function statusOf(value: Record<string, unknown>): number | undefined {
  for (const key of ["status", "statusCode", "responseStatus", "httpStatus"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && STATUS_PATTERN.test(candidate)) {
      return Number(candidate);
    }
  }
  return undefined;
}

function providerOf(value: unknown): Billing | null {
  const record = object(value);
  if (!record) {
    return null;
  }
  for (const key of ["provider", "billing"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && PROVIDERS.has(candidate as Billing)) {
      return candidate as Billing;
    }
  }
  const model = typeof record.model === "string" ? record.model : "";
  const prefix = model.slice(0, model.indexOf("/"));
  return PROVIDERS.has(prefix as Billing) ? (prefix as Billing) : null;
}

function codeOf(value: unknown): string {
  const record = object(value);
  if (!record) {
    return "";
  }
  for (const key of ["code", "type", "reason", "errorCode"]) {
    if (typeof record[key] === "string") {
      return text(record[key]);
    }
  }
  return "";
}

function messageOf(value: unknown): string {
  const record = object(value);
  if (!record) {
    return text(value);
  }
  for (const key of ["message", "error", "responseBody", "body"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      return text(candidate);
    }
    const nested = object(candidate);
    if (nested) {
      const nestedMessage = messageOf(nested);
      if (nestedMessage) {
        return nestedMessage;
      }
    }
  }
  return "";
}

function knownIssueOf(
  value: unknown,
  provider: Billing | null
): AiIssue | null {
  for (const record of errorRecords(value)) {
    const issue = aiIssueFromResponse(record, { provider });
    if (issue) {
      return issue;
    }
  }
  return null;
}

function providerSignal(value: unknown): boolean {
  const record = object(value);
  if (!record) {
    return false;
  }
  if (providerOf(record)) {
    return true;
  }
  const signal = `${codeOf(record)} ${messageOf(record)}`;
  return (
    PROVIDER_SIGNAL_PATTERN.test(signal) ||
    CANONICAL_SIGNAL_PATTERN.test(signal) ||
    CONTEXT_SIGNAL_PATTERN.test(signal)
  );
}

export function hasAiIssueSignal(value: unknown): boolean {
  const record = object(value);
  return providerSignal(record?.issue ?? record?.error ?? value);
}

function normalizeCode(
  code: string,
  status: number | undefined,
  message: string
): ModelIssueCode {
  const value = `${code} ${message}`;
  if (status === 401 || AUTH_PATTERN.test(value)) {
    return "auth_required";
  }
  if (status === 403 && FORBIDDEN_QUOTA_PATTERN.test(value)) {
    return "quota_exceeded";
  }
  if (status === 403 && FORBIDDEN_AUTH_PATTERN.test(value)) {
    return "auth_required";
  }
  if (
    code === "subscription_model_unavailable" ||
    MODEL_PATTERN.test(value) ||
    status === 404
  ) {
    return "model_unavailable";
  }
  if (CONTEXT_PATTERN.test(value)) {
    return "context_length";
  }
  if (status === 402 || QUOTA_PATTERN.test(value)) {
    return "quota_exceeded";
  }
  if (status === 429 || RATE_PATTERN.test(value)) {
    return "rate_limited";
  }
  if ((status !== undefined && status >= 500) || OUTAGE_PATTERN.test(value)) {
    return "provider_unavailable";
  }
  if (status === 400 || status === 422 || INPUT_PATTERN.test(value)) {
    return "invalid_request";
  }
  return "unknown";
}

function publicCodeFor(code: ModelIssueCode, provider: Billing | null) {
  switch (code) {
    case "auth_required":
      return provider === "chatgpt" || provider === "grok"
        ? "connection_not_connected"
        : "provider_auth_failed";
    case "quota_exceeded":
      return "provider_quota_exceeded";
    case "rate_limited":
      return "provider_rate_limited";
    case "provider_unavailable":
      return "provider_unavailable";
    case "model_unavailable":
      return "model_unavailable";
    case "context_length":
      return "context_length_exceeded";
    case "invalid_request":
      return "invalid_inference_input";
    default:
      return "inference_failed";
  }
}

export function aiIssueFromError(
  value: unknown,
  providerHint?: Billing | null
): AiIssue {
  const record = object(value);
  const nestedIssue = record?.issue;
  const source = object(nestedIssue) ? nestedIssue : value;
  const provider =
    providerOf(source) ?? providerOf(value) ?? providerHint ?? null;
  const sourceRecord = object(source);
  const status = sourceRecord ? statusOf(sourceRecord) : undefined;
  const knownIssue =
    knownIssueOf(source, provider) ?? knownIssueOf(value, provider);
  if (knownIssue) {
    return knownIssue;
  }
  return aiIssue(
    publicCodeFor(
      normalizeCode(codeOf(source), status, messageOf(source)),
      provider
    ),
    provider
  );
}

export function aiIssueText(issue: AiIssue): string {
  return `${issue.message} ${aiIssueGuidance(issue)}`;
}

/** Remove untrusted provider error payloads before a fact is written or sent to the browser. */
interface AiFact {
  data: Record<string, unknown>;
  type: string;
}

const NUL_CHARACTER = String.fromCharCode(0);
const replaceNul = (value: string) => value.replaceAll(NUL_CHARACTER, "\uFFFD");

/**
 * PostgreSQL jsonb rejects the JSON escape for U+0000. Stream facts are external
 * data, so replace only the actual NUL character at this boundary; the literal
 * escape text `\\u0000` remains unchanged. Object keys are sanitized too,
 * with a suffix on collisions so an untrusted key cannot silently overwrite data.
 */
function sanitizePersistedValue(value: unknown): unknown {
  if (typeof value === "string") {
    return replaceNul(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizePersistedValue);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const entries: [string, unknown][] = [];
  const usedKeys = new Set<string>();
  for (const [key, nested] of Object.entries(value)) {
    const baseKey = replaceNul(key);
    let safeKey = baseKey;
    let suffix = 2;
    while (usedKeys.has(safeKey)) {
      safeKey = `${baseKey} [duplicate ${suffix}]`;
      suffix += 1;
    }
    usedKeys.add(safeKey);
    entries.push([safeKey, sanitizePersistedValue(nested)]);
  }
  return Object.fromEntries(entries);
}

export function sanitizeAiFact<T extends AiFact>(
  fact: T,
  providerHint?: Billing | null
): T;
export function sanitizeAiFact(
  fact: unknown,
  providerHint?: Billing | null
): unknown;
export function sanitizeAiFact(
  fact: unknown,
  providerHint?: Billing | null
): unknown {
  const persistedFact = sanitizePersistedValue(fact);
  const root = object(persistedFact);
  if (!root || typeof root.type !== "string") {
    return persistedFact;
  }
  const data = object(root.data);
  if (!data) {
    return persistedFact;
  }
  const error = data.error ?? data.issue ?? data.reason;
  const modelFailure = root.type === "model.settled";
  const turnProviderFailure =
    root.type === "turn.settled" && providerSignal(error);
  const taskProviderFailure =
    root.type === "task.ended" && providerSignal(error);
  if (
    !(error && (modelFailure || turnProviderFailure || taskProviderFailure))
  ) {
    return persistedFact;
  }
  const issue = aiIssueFromEvent({ ...data, error }, providerHint);
  const safeData: Record<string, unknown> = Object.fromEntries(
    Object.entries(data).filter(
      ([key]) => key !== "issue" && !(taskProviderFailure && key === "reason")
    )
  );
  safeData.error = { code: issue.code, provider: issue.provider };
  return { ...root, data: safeData };
}

export function aiIssueFromEvent(
  value: unknown,
  providerHint?: Billing | null
): AiIssue {
  const record = object(value);
  const candidate = record?.issue ?? record?.error ?? value;
  return aiIssueFromError(candidate, providerHint ?? providerOf(record));
}
