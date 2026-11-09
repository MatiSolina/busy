import { z } from "zod";
import type { CapabilityInput, CapabilitySkill } from "./types";

export const MAX_CAPABILITY_BYTES = 512 * 1024;
export const MAX_CONTENT_BYTES = 384 * 1024;
export const MAX_SUPPORT_FILE_BYTES = 256 * 1024;
// The per-capability limit keeps one install reviewable; this aggregate limit
// keeps the runtime response and every dynamic skill announcement bounded.
export const MAX_ENABLED_CONTENT_BYTES = 2 * 1024 * 1024;
export const MAX_ENABLED_SKILLS = 256;
export const MAX_SKILLS = 16;
export const MAX_FILES_PER_SKILL = 128;
export const MAX_ENABLED_CAPABILITIES = 32;

const ASCII_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/u;
const RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);

const capabilityName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => ASCII_NAME.test(value),
    "Use letters, numbers, hyphens, or underscores."
  );
const skillName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine(
    (value) => ASCII_NAME.test(value),
    "Use letters, numbers, hyphens, or underscores."
  );
const requiredDescription = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine(
      (value) => utf8(value) <= max,
      `Description must be at most ${max} bytes.`
    );
const requiredContent = (max: number) =>
  z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0, "Content cannot be empty.")
    .refine(
      (value) => utf8(value) <= max,
      `Content must be at most ${max} bytes.`
    );
const boundedUtf8 = (max: number) =>
  z
    .string()
    .refine(
      (value) => utf8(value) <= max,
      `File content must be at most ${max} bytes.`
    );

const filePath = z
  .string()
  .min(1)
  .max(180)
  .refine((value) => {
    if (
      value.includes("\\") ||
      value.includes("\0") ||
      value.startsWith("/") ||
      value.includes(":")
    ) {
      return false;
    }
    if (!FILE_NAME.test(value)) {
      return false;
    }
    const parts = value.split("/");
    if (parts.at(-1)?.toLowerCase() === "skill.md") {
      return false;
    }
    return parts.every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        !RESERVED_NAMES.has(part.toLowerCase())
    );
  }, "Invalid supporting file path.");

const skillSchema = z
  .object({
    content: requiredContent(200_000),
    description: requiredDescription(2000),
    files: z
      .record(filePath, boundedUtf8(MAX_SUPPORT_FILE_BYTES))
      .superRefine((files, ctx) => {
        if (Object.keys(files).length > MAX_FILES_PER_SKILL) {
          ctx.addIssue({
            code: "custom",
            message: `A skill can contain at most ${MAX_FILES_PER_SKILL} files.`,
          });
        }
      }),
    name: skillName,
  })
  .strict();

export const capabilityInputSchema = z
  .object({
    description: requiredDescription(2000),
    kind: z.enum(["skill", "plugin"]),
    name: capabilityName,
    skills: z.array(skillSchema).min(1).max(MAX_SKILLS),
    version: z.string().trim().max(64).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const lowerName = value.name.toLowerCase();
    if (lowerName === "eve" || lowerName.startsWith("eve__")) {
      ctx.addIssue({
        code: "custom",
        message: "This capability name is reserved.",
        path: ["name"],
      });
    }
    const seen = new Set<string>();
    for (const [index, skill] of value.skills.entries()) {
      const lower = skill.name.toLowerCase();
      if (lower === "eve" || lower.startsWith("eve__")) {
        ctx.addIssue({
          code: "custom",
          message: "This skill name is reserved.",
          path: ["skills", index, "name"],
        });
      }
      if (seen.has(lower)) {
        ctx.addIssue({
          code: "custom",
          message: "Skill names must be unique within a capability.",
          path: ["skills", index, "name"],
        });
      }
      seen.add(lower);
    }
    const total = value.skills.reduce(
      (sum, skill) => {
        const files = Object.entries(skill.files).reduce(
          (n, [path, content]) => n + utf8(path) + utf8(content),
          0
        );
        return (
          sum +
          utf8(skill.name) +
          utf8(skill.description) +
          utf8(skill.content) +
          files
        );
      },
      utf8(value.name) + utf8(value.description) + utf8(value.version ?? "")
    );
    if (total > MAX_CONTENT_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `Capability content exceeds ${MAX_CONTENT_BYTES} bytes.`,
      });
    }
  });

function utf8(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parseCapabilityInput(value: unknown): CapabilityInput {
  const serialized = JSON.stringify(value);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: JSON.stringify can return undefined for non-serializable top-level input.
  if (serialized === undefined || utf8(serialized) > MAX_CAPABILITY_BYTES) {
    throw new CapabilityPayloadTooLargeError(
      "Capability payload is too large."
    );
  }
  const result = capabilityInputSchema.safeParse(value);
  if (!result.success) {
    throw new CapabilityValidationError(
      result.error.issues[0]?.message ?? "Invalid capability."
    );
  }
  return result.data;
}

export function parseCapabilityPatch(
  value: unknown
): { enabled: boolean } | CapabilityInput {
  const serialized = JSON.stringify(value);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: JSON.stringify can return undefined for non-serializable top-level input.
  if (serialized === undefined || utf8(serialized) > MAX_CAPABILITY_BYTES) {
    throw new CapabilityPayloadTooLargeError(
      "Capability payload is too large."
    );
  }
  if (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value.enabled === "boolean"
  ) {
    return { enabled: value.enabled };
  }
  return parseCapabilityInput(value);
}

export function parseCapabilitySkills(value: unknown): CapabilitySkill[] {
  const result = z.array(skillSchema).safeParse(value);
  if (!result.success) {
    throw new CapabilityValidationError(
      "Stored capability contains invalid skills."
    );
  }
  return result.data;
}

export class CapabilityValidationError extends Error {}
export class CapabilityPayloadTooLargeError extends CapabilityValidationError {}
export class CapabilityConflictError extends Error {}
export class CapabilityNotFoundError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
