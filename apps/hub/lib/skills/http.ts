import { capabilityJson } from "@/lib/capabilities/http";
import { CapabilityImportError } from "@/lib/capabilities/import";
import {
  CapabilityConflictError,
  CapabilityNotFoundError,
  CapabilityPayloadTooLargeError,
  CapabilityValidationError,
} from "@/lib/capabilities/validation";
import {
  SkillsChangedError,
  SkillsNotFoundError,
  SkillsRateLimitError,
  SkillsSnapshotUnavailableError,
  SkillsUnavailableError,
  SkillsValidationError,
} from "./catalog";

export function skillsJson(data: unknown, status = 200) {
  return capabilityJson(data, status);
}

export function skillsError(error: unknown) {
  if (error instanceof CapabilityPayloadTooLargeError) {
    return skillsJson({ error: error.message }, 413);
  }
  if (error instanceof CapabilityValidationError) {
    return skillsJson({ error: error.message }, 422);
  }
  if (error instanceof CapabilityConflictError) {
    return skillsJson({ error: error.message }, 409);
  }
  if (error instanceof CapabilityNotFoundError) {
    return skillsJson({ error: error.message }, 404);
  }
  if (error instanceof CapabilityImportError) {
    return skillsJson({ error: error.message }, 422);
  }
  if (error instanceof SkillsValidationError) {
    return skillsJson({ error: error.message }, 400);
  }
  if (error instanceof SkillsSnapshotUnavailableError) {
    return skillsJson({ error: error.message }, 422);
  }
  if (error instanceof SkillsNotFoundError) {
    return skillsJson({ error: error.message }, 404);
  }
  if (error instanceof SkillsChangedError) {
    return skillsJson({ error: error.message }, 409);
  }
  if (error instanceof SkillsRateLimitError) {
    const response = skillsJson({ error: error.message }, 429);
    if (error.retryAfter) {
      response.headers.set("Retry-After", error.retryAfter);
    }
    return response;
  }
  if (error instanceof SkillsUnavailableError) {
    return skillsJson({ error: error.message }, 503);
  }
  return skillsJson({ error: "Skills catalog operation failed." }, 500);
}
