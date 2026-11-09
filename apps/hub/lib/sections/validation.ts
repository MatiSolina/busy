import { z } from "zod";

export const MAX_SECTION_NAME_LENGTH = 60;
export const MAX_SECTION_JSON_BYTES = 16 * 1024;

export class SectionPayloadTooLargeError extends Error {
  constructor(message = "Section payload is too large.") {
    super(message);
    this.name = "SectionPayloadTooLargeError";
  }
}

export class SectionValidationError extends Error {
  constructor(message = "Invalid section request.", options?: ErrorOptions) {
    super(message, options);
    this.name = "SectionValidationError";
  }
}

const sectionName = z.string().trim().min(1).max(MAX_SECTION_NAME_LENGTH);

export const createSectionInput = z.strictObject({ name: sectionName });
export const updateSectionInput = z.strictObject({ name: sectionName });
export const assignSectionInput = z.strictObject({
  sectionId: z.uuid().nullable(),
});

export type CreateSectionInput = z.infer<typeof createSectionInput>;
export type UpdateSectionInput = z.infer<typeof updateSectionInput>;
export type AssignSectionInput = z.infer<typeof assignSectionInput>;

export async function readSectionJson(req: Request): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_SECTION_JSON_BYTES) {
    throw new SectionPayloadTooLargeError();
  }

  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    try {
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: A ReadableStream must be consumed chunk by chunk.
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > MAX_SECTION_JSON_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new SectionPayloadTooLargeError();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await req.text();
    if (new TextEncoder().encode(text).byteLength > MAX_SECTION_JSON_BYTES) {
      throw new SectionPayloadTooLargeError();
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SectionValidationError("Invalid section request.", {
      cause: error,
    });
  }
}

export function parseCreateSection(value: unknown): CreateSectionInput {
  const result = createSectionInput.safeParse(value);
  if (!result.success) {
    throw new SectionValidationError();
  }
  return result.data;
}

export function parseUpdateSection(value: unknown): UpdateSectionInput {
  const result = updateSectionInput.safeParse(value);
  if (!result.success) {
    throw new SectionValidationError();
  }
  return result.data;
}

export function parseAssignSection(value: unknown): AssignSectionInput {
  const result = assignSectionInput.safeParse(value);
  if (!result.success) {
    throw new SectionValidationError();
  }
  return result.data;
}

export function parseSectionId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new SectionValidationError();
  }
  return result.data;
}
