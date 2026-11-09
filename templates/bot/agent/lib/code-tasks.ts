import { createHash } from "node:crypto";
import { z } from "zod";
import { type HubFetch, hubFetch } from "./hub";

export const codeTaskStatus = z.enum([
  "queued",
  "running",
  "waiting_for_input",
  "ready",
  "cancel_requested",
  "cancelled",
  "failed",
  "needs_attention",
]);
export type CodeTaskStatus = z.infer<typeof codeTaskStatus>;

export const codeTaskSummary = z
  .object({
    appliedInstructionVersion: z.number().int().nonnegative(),
    branch: z.string().nullable(),
    commitSha: z.string().nullable(),
    createdAt: z.string(),
    error: z.string().nullable(),
    id: z.uuid(),
    instructionVersion: z.number().int().nonnegative(),
    phase: z.string().nullable(),
    prUrl: z.string().nullable(),
    repository: z.object({
      baseBranch: z.string(),
      fullName: z.string(),
      id: z.uuid(),
    }),
    revision: z.number().int().nonnegative(),
    status: codeTaskStatus,
    summary: z.string().nullable(),
    title: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
export type CodeTaskSummary = z.infer<typeof codeTaskSummary>;

export type CodeTaskFetcher = HubFetch;

/** Stable UUID used as the hub's idempotency key for a tool call. */
export function stableCodeTaskId(
  sessionId: string,
  callId: string,
  suffix = "task"
): string {
  const bytes = createHash("sha256")
    .update(`busy-code-task\0${suffix}\0${sessionId}\0${callId}`)
    .digest();
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function stableCodeTaskCommandId(
  sessionId: string,
  callId: string,
  taskId: string,
  kind: "steer" | "cancel"
): string {
  return stableCodeTaskId(sessionId, callId, `${kind}:${taskId}`);
}

const ERROR_TEXT = /^[\p{L}\p{N}\s.,;:'()/_-]+$/u;
const SECRET_TEXT =
  /(?<secret>token|secret|password|authorization|bearer|api[_-]?key|github_pat|ghp_|sk-)/iu;

function errorResult(
  action: string,
  status?: number,
  detail?: unknown
): { error: string } {
  if (typeof detail === "string") {
    const message = detail.trim();
    if (
      message.length > 0 &&
      message.length <= 300 &&
      ERROR_TEXT.test(message) &&
      !SECRET_TEXT.test(message)
    ) {
      return { error: message };
    }
  }
  if (status === undefined) {
    return { error: "Couldn't reach the code task service." };
  }
  if (status === 404) {
    return { error: "That code task was not found." };
  }
  if (status === 409) {
    return { error: "That code task is not available for this operation." };
  }
  return { error: `Couldn't ${action} code task (${status})` };
}

async function request(
  action: string,
  path: string,
  fetcher: CodeTaskFetcher,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch {
    return errorResult(action);
  }
  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.clone().json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const candidate = body as Record<string, unknown>;
        detail = candidate.error ?? candidate.message;
      }
    } catch {
      detail = undefined;
    }
    return errorResult(action, response.status, detail);
  }
  try {
    const body = await response.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : { ok: true };
  } catch {
    return { error: `Couldn't ${action} code task.` };
  }
}

export interface StartCodeTaskInput {
  acceptanceCriteria?: string[];
  goal: string;
  id: string;
  repositoryId?: string;
  sourceCallId: string;
  sourceSessionId: string;
  title: string;
}

export function startCodeTask(
  input: StartCodeTaskInput,
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request("start", "/api/bot/code-tasks", fetcher, {
    body: JSON.stringify(input),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

export function listCodeTasks(
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "list",
    "/api/bot/code-tasks",
    fetcher,
    signal ? { signal } : undefined
  );
}

export function getCodeTask(
  taskId: string,
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "read",
    `/api/bot/code-tasks/${encodeURIComponent(taskId)}`,
    fetcher,
    signal ? { signal } : undefined
  );
}

/**
 * Fail-closed ownership proof used before a code task is attached to a plan.
 * The hub endpoint must return a short authenticated `binding` object; a
 * public task summary or a UUID alone is not sufficient.
 */
export async function verifyCodeTaskOwnership(
  taskId: string,
  sourceSessionId: string,
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetcher(
      `/api/bot/code-tasks/${encodeURIComponent(taskId)}?sourceSessionId=${encodeURIComponent(sourceSessionId)}`,
      signal ? { signal } : undefined
    );
  } catch {
    return false;
  }
  if (!response.ok) {
    return false;
  }
  try {
    const body = (await response.json()) as {
      binding?: { taskId?: unknown; sourceSessionId?: unknown };
    };
    return (
      body.binding?.taskId === taskId &&
      body.binding?.sourceSessionId === sourceSessionId
    );
  } catch {
    return false;
  }
}

export function updateCodeTask(
  taskId: string,
  input: {
    id: string;
    sourceSessionId: string;
    sourceCallId: string;
    text: string;
  },
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "update",
    `/api/bot/code-tasks/${encodeURIComponent(taskId)}/commands`,
    fetcher,
    {
      body: JSON.stringify({ ...input, kind: "steer" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      ...(signal ? { signal } : {}),
    }
  );
}

export function cancelCodeTask(
  taskId: string,
  input: { id: string; sourceSessionId: string; sourceCallId: string },
  fetcher: CodeTaskFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "cancel",
    `/api/bot/code-tasks/${encodeURIComponent(taskId)}/commands`,
    fetcher,
    {
      body: JSON.stringify({ ...input, kind: "cancel" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      ...(signal ? { signal } : {}),
    }
  );
}
