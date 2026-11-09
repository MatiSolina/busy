import { mcpJson } from "@/lib/mcp/http";
import {
  CapabilityConflictError,
  CapabilityNotFoundError,
  CapabilityPayloadTooLargeError,
  CapabilityValidationError,
} from "./validation";

export function capabilityJson(data: unknown, status = 200) {
  return mcpJson(data, status);
}

export function capabilityError(error: unknown) {
  if (error instanceof CapabilityPayloadTooLargeError) {
    return capabilityJson({ error: error.message }, 413);
  }
  if (error instanceof CapabilityValidationError) {
    return capabilityJson({ error: error.message }, 400);
  }
  if (error instanceof CapabilityConflictError) {
    return capabilityJson({ error: error.message }, 409);
  }
  if (error instanceof CapabilityNotFoundError) {
    return capabilityJson({ error: error.message }, 404);
  }
  return capabilityJson({ error: "Capability operation failed." }, 500);
}
