import {
  type CodeRepositoryStatusResult,
  codeRepositoryStatus,
} from "./code-repository-setup";
import { type HubFetch, hubFetch } from "./hub";

const SAFE_ERROR = /^[\p{L}\p{N}\s.,;:'()/_-]+$/u;
const SECRET_TEXT =
  /(?<secret>token|secret|password|authorization|bearer|api[_-]?key|github_pat|ghp_|sk-)/iu;

function safeError(status: number, detail: unknown): string {
  if (typeof detail === "string") {
    const message = detail.trim();
    if (
      message.length > 0 &&
      message.length <= 300 &&
      SAFE_ERROR.test(message) &&
      !SECRET_TEXT.test(message)
    ) {
      return message;
    }
  }
  if (status === 403) {
    return "This conversation cannot prepare a code repository.";
  }
  return "Couldn't check the GitHub repository connection.";
}

export async function getCodeRepositoryStatus(
  sourceSessionId: string,
  repositoryId?: string,
  fetcher: HubFetch = hubFetch,
  signal?: AbortSignal
): Promise<CodeRepositoryStatusResult> {
  const query = new URLSearchParams({ sourceSessionId });
  if (repositoryId) {
    query.set("repositoryId", repositoryId);
  }
  let response: Response;
  try {
    response = await fetcher(`/api/bot/code-repository?${query}`, {
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { error: "Couldn't reach the code repository service." };
  }
  if (!response.ok) {
    let detail: unknown;
    try {
      const body = await response.clone().json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        detail = (body as Record<string, unknown>).error;
      }
    } catch {
      detail = undefined;
    }
    return { error: safeError(response.status, detail) };
  }
  try {
    const parsed = codeRepositoryStatus.safeParse(await response.json());
    return parsed.success
      ? parsed.data
      : { error: "The code repository service returned an invalid status." };
  } catch {
    return { error: "The code repository service returned an invalid status." };
  }
}
