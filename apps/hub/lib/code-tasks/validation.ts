import { z } from "zod";
import {
  CODE_TASK_COMMAND_KINDS,
  CODE_TASK_STATUSES,
  type CodeTaskCommandInput,
  type CreateCodeTaskInput,
} from "./types";

const uuid = z.uuid();
const billing = z.enum(["token-pass", "gateway", "chatgpt", "grok"]);

export const repositorySnapshotSchema = z.strictObject({
  baseBranch: z.string().trim().min(1).max(255),
  fullName: z
    .string()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u),
  id: uuid,
});

export const aiSnapshotSchema = z.strictObject({
  agentName: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
    .optional(),
  billing,
  fast: z.boolean(),
  model: z.string().trim().min(1).max(200),
});

export const createCodeTaskSchema = z.strictObject({
  ai: aiSnapshotSchema,
  botId: uuid,
  branch: z.string().trim().max(255).nullable().optional(),
  goal: z.string().trim().min(1).max(20_000),
  id: uuid,
  repository: repositorySnapshotSchema,
  repositoryId: uuid,
  sourceCallId: z.string().trim().min(1).max(255),
  sourceMessageId: z.string().trim().max(255).nullable().optional(),
  sourceSessionId: z.string().trim().min(1).max(255),
  title: z.string().trim().min(1).max(200),
});

export const codeTaskCommandSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative().optional(),
  instructionVersion: z.number().int().nonnegative().optional(),
  kind: z.enum(CODE_TASK_COMMAND_KINDS),
  messageId: z.string().trim().min(1).max(255).optional(),
  revision: z.number().int().positive().optional(),
  text: z
    .string()
    .trim()
    .max(64 * 1024)
    .nullable()
    .optional(),
});

export const codeTaskStatusSchema = z.enum(CODE_TASK_STATUSES);

export function parseCreateCodeTask(input: unknown): CreateCodeTaskInput {
  return createCodeTaskSchema.parse(input);
}

export function parseCodeTaskCommand(input: unknown): CodeTaskCommandInput {
  return codeTaskCommandSchema.parse(input);
}

export function isCodeTaskStatus(
  value: unknown
): value is (typeof CODE_TASK_STATUSES)[number] {
  return (
    typeof value === "string" && codeTaskStatusSchema.safeParse(value).success
  );
}
