import { createHash } from "node:crypto";
import { type HubFetch, hubFetch } from "./hub";

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

export interface Routine {
  daysOfWeek: number[];
  enabled: boolean;
  id: string;
  name: string;
  nextRunAt?: string | null;
  prompt: string;
  time: string;
  timeZone: string;
}

export interface RoutineCreate {
  daysOfWeek: number[];
  id: string;
  name: string;
  prompt: string;
  time: string;
  timeZone: string;
}

export type RoutinePatch = Partial<Omit<RoutineCreate, "id">> & {
  enabled?: boolean;
};

export type RoutineFetcher = HubFetch;

type RoutineAction = "list" | "create" | "update" | "delete";

/**
 * A stable UUID for one tool call. The model never chooses routine ids, so a retried
 * request after a lost response can be safely deduplicated by the hub.
 */
export function stableRoutineId(sessionId: string, callId: string): string {
  const bytes = createHash("sha256").update(`${sessionId}\0${callId}`).digest();
  // RFC 4122 variant + version 5 bits, while retaining all other digest bits.
  // biome-ignore lint/suspicious/noBitwiseOperators: RFC 4122 requires bit masks for UUID version and variant bits.
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // biome-ignore lint/suspicious/noBitwiseOperators: RFC 4122 requires bit masks for UUID version and variant bits.
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function errorResult(
  action: RoutineAction,
  status?: number
): { error: string } {
  if (status === undefined) {
    return { error: "Couldn't reach the routines service." };
  }
  return { error: `Couldn't ${action} routines (${status})` };
}

async function request(
  action: RoutineAction,
  path: string,
  fetcher: RoutineFetcher,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch {
    return errorResult(action);
  }
  if (!response.ok) {
    return errorResult(action, response.status);
  }
  if (response.status === 204) {
    return { ok: true };
  }
  try {
    const body = await response.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : { ok: true };
  } catch {
    return { error: `Couldn't ${action} routines.` };
  }
}

export function listRoutines(
  fetcher: RoutineFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "list",
    "/api/bot/routines",
    fetcher,
    signal ? { signal } : undefined
  );
}

export function createRoutine(
  input: RoutineCreate,
  fetcher: RoutineFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request("create", "/api/bot/routines", fetcher, {
    body: JSON.stringify(input),
    method: "POST",
    ...(signal ? { signal } : {}),
  });
}

export function updateRoutine(
  id: string,
  patch: RoutinePatch,
  fetcher: RoutineFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "update",
    `/api/bot/routines/${encodeURIComponent(id)}`,
    fetcher,
    {
      body: JSON.stringify(patch),
      method: "PATCH",
      ...(signal ? { signal } : {}),
    }
  );
}

export function deleteRoutine(
  id: string,
  fetcher: RoutineFetcher = hubFetch,
  signal?: AbortSignal
) {
  return request(
    "delete",
    `/api/bot/routines/${encodeURIComponent(id)}`,
    fetcher,
    {
      method: "DELETE",
      ...(signal ? { signal } : {}),
    }
  );
}
