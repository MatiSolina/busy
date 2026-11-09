import { z } from "zod";

export const learnedSkillInput = z.object({
  description: z
    .string()
    .trim()
    .min(10)
    .max(500)
    .describe(
      "When to use it, in one sentence: what it's for and what triggers it."
    ),
  instructions: z
    .string()
    .trim()
    .min(40)
    .max(20_000)
    .describe(
      "The workflow as numbered steps another run of you can follow: inputs, where to find them, tools, checks, the format of the result. No secrets, passwords or one-off values."
    ),
  name: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/u)
    .describe("kebab-case, e.g. monthly-sales-report"),
});

export type LearnedSkillInput = z.infer<typeof learnedSkillInput>;

export function proposalPrompt(
  { name, description, instructions }: LearnedSkillInput,
  editing: boolean
): string {
  const steps = instructions.split("\n").filter((line) => line.trim()).length;
  return `${editing ? "Update" : "Save"} the skill "${name}"? ${description} (${steps} ${steps === 1 ? "line" : "lines"} of instructions; you can read and edit it in Skills.)`;
}
