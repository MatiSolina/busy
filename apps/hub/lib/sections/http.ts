import {
  BotNotFoundError,
  SectionConflictError,
  SectionNotFoundError,
} from "./types";
import {
  SectionPayloadTooLargeError,
  SectionValidationError,
} from "./validation";

const headers = { "Cache-Control": "private, no-store" };

export function sectionJson(data: unknown, status = 200): Response {
  return Response.json(data, { headers, status });
}

export function sectionError(error: unknown): Response {
  if (error instanceof SectionPayloadTooLargeError) {
    return sectionJson({ error: error.message }, 413);
  }
  if (error instanceof SectionValidationError) {
    return sectionJson({ error: error.message }, 400);
  }
  if (error instanceof SectionConflictError) {
    return sectionJson({ error: error.message }, 409);
  }
  if (
    error instanceof SectionNotFoundError ||
    error instanceof BotNotFoundError
  ) {
    return sectionJson({ error: error.message }, 404);
  }
  return sectionJson({ error: "Could not update sections." }, 500);
}
