import type {
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPromptContext,
  ApprovalStatus,
  ConnectionToolAnnotations,
} from "eve/tools/approval";
import { isConsultation } from "./caller";
import { type HubFetch, hubFetch } from "./hub";

const READ_VERBS = [
  "get",
  "list",
  "search",
  "find",
  "read",
  "fetch",
  "query",
  "view",
  "show",
  "describe",
  "lookup",
  "retrieve",
  "count",
  "check",
  "inspect",
  "preview",
  "summarize",
  "whoami",
  "me",
];

const OUTWARD_VERBS: { verbs: string[]; phrase: string }[] = [
  {
    phrase: "delete or cancel something",
    verbs: [
      "delete",
      "remove",
      "trash",
      "archive",
      "destroy",
      "drop",
      "purge",
      "cancel",
      "revoke",
      "unsubscribe",
    ],
  },
  {
    phrase: "move money",
    verbs: [
      "pay",
      "charge",
      "refund",
      "transfer",
      "payout",
      "purchase",
      "buy",
      "checkout",
      "invoice",
    ],
  },
  {
    phrase: "send or publish something",
    verbs: [
      "send",
      "reply",
      "forward",
      "post",
      "publish",
      "tweet",
      "share",
      "invite",
      "email",
      "message",
      "notify",
      "comment",
    ],
  },
];

export type ToolKind = "read" | "write";

// MCP names arrive qualified (`mcp-gmail__send_message`); the policy only reads the remote part.
function remoteName(toolName: string): string {
  const separator = toolName.lastIndexOf("__");
  return separator === -1 ? toolName : toolName.slice(separator + 2);
}

export function bareToolName(toolName: string): string {
  return remoteName(toolName).toLowerCase();
}

const CAMEL_BOUNDARY = /(?<lower>[a-z0-9])(?<upper>[A-Z])/gu;
const NON_WORD = /[^a-z0-9]+/u;
const MCP_PREFIX = /^mcp[-_]/u;
const SEPARATORS = /[_-]+/gu;
const WORD_START = /\b\w/gu;
const WHITESPACE = /\s+/gu;

function words(name: string): string[] {
  return name
    .replace(CAMEL_BOUNDARY, "$<lower>_$<upper>")
    .toLowerCase()
    .split(NON_WORD)
    .filter(Boolean);
}

// Annotations win when the server declares them. Without them, only a name that starts with a read
// verb counts as a read: an unknown verb is treated as a write, so a new server asks rather than acts.
export function toolKind(
  toolName: string,
  annotations?: ConnectionToolAnnotations
): ToolKind {
  if (annotations?.readOnlyHint === true) {
    return "read";
  }
  if (
    annotations?.readOnlyHint === false ||
    annotations?.destructiveHint === true
  ) {
    return "write";
  }
  const [first] = words(remoteName(toolName));
  return first && READ_VERBS.includes(first) ? "read" : "write";
}

export function marketplaceApprovalPolicy(
  ctx: Pick<ApprovalContext, "session" | "toolName" | "toolAnnotations">
): ApprovalStatus {
  // A consultation sends nothing to third parties. A "read" still carries arbitrary arguments to
  // the MCP provider (readOnlyHint is not a confidentiality guarantee), so every MCP call is denied
  // there before the provider sees it. Exceptions would need an explicit per-connection policy.
  if (isConsultation(ctx.session.auth)) {
    return {
      reason:
        "Consultations can't use connected apps: this needs the user's own chat.",
      type: "denied",
    };
  }
  const kind = toolKind(ctx.toolName, ctx.toolAnnotations);
  if (kind === "read") {
    return "not-applicable";
  }
  return "user-approval";
}

/**
 * ACL enforcement is intentionally separate from approval. Eve may retain a
 * tool call in session history after the dynamic connection has been rebuilt;
 * this policy still denies it before the remote server sees the call.
 */
export function marketplaceToolPolicy(
  allowedTools: readonly string[],
  ctx: Pick<ApprovalContext, "session" | "toolName" | "toolAnnotations">
): ApprovalStatus {
  const allowed = new Set(allowedTools.map((name) => name.toLowerCase()));
  if (!allowed.has(bareToolName(ctx.toolName))) {
    return {
      reason: "This MCP tool is not enabled for the current connection.",
      type: "denied",
    };
  }
  return marketplaceApprovalPolicy(ctx);
}

/** Re-read the hub ACL for every invocation; never trust a stale Eve tool list. */
export async function currentMarketplaceToolPolicy(
  connectionId: string,
  fallbackAllowedTools: readonly string[] | null,
  ctx: Pick<ApprovalContext, "session" | "toolName" | "toolAnnotations">,
  fetcher: HubFetch = hubFetch
): Promise<ApprovalStatus> {
  try {
    const response = await fetcher("/api/bot/mcp");
    if (!response.ok) {
      return {
        reason: "Busy could not verify this MCP connection.",
        type: "denied",
      };
    }
    const body = (await response.json()) as {
      connections?: Array<{
        aclMode?: unknown;
        allowedTools?: unknown;
        id?: unknown;
        tools?: Array<{
          name?: unknown;
          ui?: { visibility?: unknown };
        }>;
      }>;
    };
    const current = body.connections?.find((item) => item.id === connectionId);
    if (!current) {
      return {
        reason: "This MCP connection is no longer available to this bot.",
        type: "denied",
      };
    }
    const reviewedTool = current.tools?.find(
      (tool) =>
        typeof tool.name === "string" &&
        tool.name.toLowerCase() === bareToolName(ctx.toolName)
    );
    const visibility = reviewedTool?.ui?.visibility;
    if (Array.isArray(visibility) && !visibility.includes("model")) {
      return {
        reason: "This MCP tool is only available to its interactive app.",
        type: "denied",
      };
    }
    if (current.aclMode === "legacy") {
      return marketplaceApprovalPolicy(ctx);
    }
    const allowed = Array.isArray(current.allowedTools)
      ? current.allowedTools.filter(
          (name): name is string => typeof name === "string"
        )
      : (fallbackAllowedTools ?? []);
    return marketplaceToolPolicy(allowed, ctx);
  } catch {
    return {
      reason: "Busy could not verify this MCP connection.",
      type: "denied",
    };
  }
}

function humanToolName(toolName: string): string {
  return words(remoteName(toolName)).join(" ");
}

function connectionLabel(toolName: string): string {
  const separator = toolName.lastIndexOf("__");
  const connection =
    separator === -1
      ? ""
      : toolName.slice(0, separator).replace(MCP_PREFIX, "");
  return connection
    ? connection
        .replace(SEPARATORS, " ")
        .replace(WORD_START, (letter) => letter.toUpperCase())
    : "an app";
}

const SUMMARY_KEYS = [
  "to",
  "recipient",
  "recipients",
  "email",
  "channel",
  "subject",
  "title",
  "name",
  "amount",
  "currency",
  "text",
  "body",
  "message",
  "content",
  "id",
];

function fieldText(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === "string" || typeof item === "number")
      .join(", ");
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return "";
}

// One short line the person can judge at a glance: what, where, and the two or three fields that matter.
export function summarizeInput(input: unknown, max = 160): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return "";
  }
  const record = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (value === undefined || value === null || value === "") {
      continue;
    }
    const text = fieldText(value);
    if (!text) {
      continue;
    }
    parts.push(`${key}: ${text.replace(WHITESPACE, " ").trim()}`);
    if (parts.length === 3) {
      break;
    }
  }
  const line = parts.join(" · ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function approvalPrompt({
  toolName,
  input,
}: Pick<ApprovalPromptContext, "toolName" | "input">): string {
  const name = humanToolName(toolName);
  const verbs = words(remoteName(toolName));
  const outward = OUTWARD_VERBS.find(({ verbs: list }) =>
    verbs.some((verb) => list.includes(verb))
  );
  const action = outward
    ? `I'm about to ${outward.phrase} in ${connectionLabel(toolName)} (${name})`
    : `I'm about to use "${name}" in ${connectionLabel(toolName)}`;
  const summary = summarizeInput(input);
  return summary ? `${action}. ${summary}. OK?` : `${action}. OK?`;
}

export const marketplaceApproval: ApprovalConfiguration = {
  prompt: approvalPrompt,
  request: marketplaceApprovalPolicy,
};
