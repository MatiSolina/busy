import { ZodError, type ZodType, z } from "zod";
import { RoutineConflictError, RoutineNotFoundError } from "./types";

export const MAX_ROUTINE_BODY_BYTES = 32 * 1024;

export class RoutinePayloadTooLargeError extends Error {}
export class RoutineValidationError extends Error {}

/** Every routine response is private and must be revalidated after a write. */
export function routineJson(data: unknown, status = 200) {
  return Response.json(data, {
    headers: { "Cache-Control": "no-store" },
    status,
  });
}

/**
 * Read a JSON route body with a bounded byte count. Content-Length is only an early rejection;
 * streamed requests are counted while reading so chunked requests cannot bypass the limit.
 */
export async function readRoutineJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_ROUTINE_BODY_BYTES) {
    throw new RoutinePayloadTooLargeError("Routine payload is too large.");
  }

  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: Stream chunks must be consumed in order and bounded by bytes.
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > MAX_ROUTINE_BODY_BYTES) {
          await reader.cancel().catch(() => {
            // The request is already over its size limit; cancellation is best effort.
          });
          throw new RoutinePayloadTooLargeError(
            "Routine payload is too large."
          );
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_ROUTINE_BODY_BYTES) {
      throw new RoutinePayloadTooLargeError("Routine payload is too large.");
    }
  }

  try {
    return JSON.parse(text);
  } catch {
    // biome-ignore lint/style/useErrorCause: Invalid user JSON is reported as a stable validation error without parser details.
    throw new RoutineValidationError("Invalid routine JSON.");
  }
}

export function routineValidationError(error: unknown): Response {
  if (error instanceof RoutinePayloadTooLargeError) {
    return routineJson({ error: error.message }, 413);
  }
  if (error instanceof RoutineValidationError || error instanceof ZodError) {
    return routineJson(
      {
        error:
          error instanceof ZodError
            ? (error.issues[0]?.message ?? "Invalid routine.")
            : error.message,
      },
      400
    );
  }
  if (error instanceof RoutineConflictError) {
    return routineJson({ error: error.message }, 409);
  }
  if (error instanceof RoutineNotFoundError) {
    return routineJson({ error: "Routine not found." }, 404);
  }
  return routineJson({ error: "Routine operation failed." }, 500);
}

export function parseRoutineBody<T>(value: unknown, schema: ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RoutineValidationError(
      parsed.error.issues[0]?.message ?? "Invalid routine."
    );
  }
  return parsed.data;
}

export function parseRoutineId(id: string): string {
  if (!z.uuid().safeParse(id).success) {
    throw new RoutineNotFoundError();
  }
  return id;
}
