import { cookies } from "next/headers";
import { z } from "zod";
import { aiIssue, issueFromError, issueResponse } from "@/lib/ai/errors";
import {
  AiProviderUnavailableError,
  getAiSettings,
  saveAiSettings,
} from "@/lib/ai/settings";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session";

const MAX_BODY_BYTES = 8 * 1024;
const input = z
  .object({
    model: z.string().max(200).optional(),
    provider: z.enum(["token-pass", "gateway", "chatgpt", "grok"]),
  })
  .strict();

async function authenticated(): Promise<boolean> {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return true;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    return false;
  }
  return Boolean(
    await readSession((await cookies()).get(SESSION_COOKIE)?.value, secret)
  );
}

const responseHeaders = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
};

function withResponseHeaders(response: Response): Response {
  for (const [key, value] of Object.entries(responseHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export async function GET() {
  if (!(await authenticated())) {
    return withResponseHeaders(issueResponse(aiIssue("unauthorized"), 401));
  }
  try {
    return Response.json(await getAiSettings(), { headers: responseHeaders });
  } catch {
    return withResponseHeaders(issueResponse(aiIssue("could_not_load"), 503));
  }
}

export async function PUT(req: Request) {
  if (!(await authenticated())) {
    return withResponseHeaders(issueResponse(aiIssue("unauthorized"), 401));
  }
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return withResponseHeaders(
      issueResponse(aiIssue("payload_too_large"), 413)
    );
  }

  let body: unknown;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      return withResponseHeaders(
        issueResponse(aiIssue("payload_too_large"), 413)
      );
    }
    body = JSON.parse(text);
  } catch {
    return withResponseHeaders(issueResponse(aiIssue("invalid_data"), 400));
  }
  const parsed = input.safeParse(body);
  if (!parsed.success) {
    return withResponseHeaders(issueResponse(aiIssue("invalid_data"), 400));
  }
  try {
    const saved =
      parsed.data.model === undefined
        ? await saveAiSettings(parsed.data.provider)
        : await saveAiSettings(
            parsed.data.provider,
            undefined,
            parsed.data.model
          );
    return Response.json(saved, {
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof AiProviderUnavailableError) {
      return withResponseHeaders(
        issueResponse(
          error.issue ?? aiIssue("provider_unconfigured", parsed.data.provider),
          409
        )
      );
    }
    return withResponseHeaders(
      issueResponse(
        issueFromError(error, parsed.data.provider, "could_not_save"),
        500
      )
    );
  }
}
