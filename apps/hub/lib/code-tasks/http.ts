import { z } from "zod";
import {
  CodeTaskAuthorizationError,
  CodeTaskConflictError,
  CodeTaskNotFoundError,
} from "./types";

export class CodeTaskHttpError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
    this.name = "CodeTaskHttpError";
  }
}

export function codeJson(value: unknown, status = 200): Response {
  return Response.json(value, {
    headers: { "Cache-Control": "no-store" },
    status,
  });
}

/** Only fixed application errors cross the HTTP boundary. Upstream errors may quote credentials. */
export function codeError(error: unknown): Response {
  if (error instanceof CodeTaskHttpError) {
    return codeJson({ error: error.message }, error.status);
  }
  if (error instanceof CodeTaskNotFoundError) {
    return codeJson({ error: "Code task or repository not found." }, 404);
  }
  if (error instanceof CodeTaskAuthorizationError) {
    return codeJson({ error: "This bot cannot access that code task." }, 403);
  }
  if (error instanceof CodeTaskConflictError) {
    return codeJson({ error: error.message.slice(0, 300) }, 409);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return codeJson({ error: "Invalid code task request." }, 400);
  }
  return codeJson(
    {
      error:
        "The code task service is unavailable. Check its setup and try again.",
    },
    503
  );
}

export async function codeBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 100_000) {
    throw new CodeTaskHttpError("The code task request is too large.", 413);
  }
  return JSON.parse(text);
}
