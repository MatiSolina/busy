import { type HubFetch, hubFetch } from "./hub";

export interface HistoryResult {
  createdAt: string;
  id: string;
  role: "user" | "assistant";
  score: number;
  sessionId: string | null;
  source: "message" | "event";
  text: string;
  turnId: string | null;
}

export interface HistoryResponse {
  mode: "lexical";
  query: string;
  result?: HistoryResult & {
    before: HistoryResult[];
    after: HistoryResult[];
  };
  results: HistoryResult[];
}

export async function searchHistory(
  query: string,
  limit = 8,
  fetcher: HubFetch = hubFetch,
  signal?: AbortSignal
): Promise<HistoryResponse | { error: string }> {
  let response: Response;
  try {
    const params = new URLSearchParams({ limit: String(limit), q: query });
    response = await fetcher(
      `/api/bot/history?${params}`,
      signal ? { signal } : undefined
    );
  } catch {
    return { error: "History search is unavailable." };
  }
  if (!response.ok) {
    return { error: `History search failed (${response.status}).` };
  }
  return (await response.json()) as HistoryResponse;
}

export async function readHistory(
  query: string,
  id: string,
  fetcher: HubFetch = hubFetch,
  signal?: AbortSignal
): Promise<HistoryResponse | { error: string }> {
  let response: Response;
  try {
    const params = new URLSearchParams({ around: id, limit: "8", q: query });
    response = await fetcher(
      `/api/bot/history?${params}`,
      signal ? { signal } : undefined
    );
  } catch {
    return { error: "History context is unavailable." };
  }
  if (!response.ok) {
    return { error: `History context failed (${response.status}).` };
  }
  return (await response.json()) as HistoryResponse;
}
