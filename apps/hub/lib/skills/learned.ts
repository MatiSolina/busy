import { z } from "zod";
import {
  type CapabilityRow,
  type CatalogChange,
  changeCapabilityCatalog,
  publicCapability,
  runtimeSkillName,
} from "@/lib/capabilities/store";
import type {
  CapabilityInput,
  PublicCapability,
} from "@/lib/capabilities/types";
import {
  CapabilityConflictError,
  capabilityInputSchema,
  parseCapabilitySkills,
} from "@/lib/capabilities/validation";

const skillName = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/u,
    "Use lowercase letters, numbers and hyphens."
  );

/** A workflow the bot learned in conversation and the user agreed to keep. */
export const learnedSkillSchema = z
  .object({
    description: z.string().trim().min(10).max(500),
    // The user tapped "Update skill" on a proposal that named an existing skill.
    edit: z.boolean().default(false),
    instructions: z.string().trim().min(40).max(20_000),
    name: skillName,
  })
  .strict();

export type LearnedSkill = z.input<typeof learnedSkillSchema>;

export interface SavedLearnedSkill {
  capability: PublicCapability;
  created: boolean;
  loadName: string;
}

/**
 * Create the skill in the app's shared set, so every bot can use it. A taken name is refused unless
 * The user approved an update of that skill (`edit`), and an update rewrites only the skill of that
 * name: the capability's other skills and files stay. A skill installed from skills.sh is never
 * overwritten from chat: its reviewed revision stays what the user approved.
 *
 * Every decision is taken on the rows read under the catalog lock, and the skill is merged into the
 * array just read, so a concurrent save or edit of the same capability is never replaced by a
 * stale copy. Learned names are lowercase (`learnedSkillSchema`); matching an existing capability
 * case-insensitively is this surface's policy only. The general catalog stays case-sensitive.
 */
export async function saveLearnedSkill(
  skill: LearnedSkill
): Promise<SavedLearnedSkill> {
  const { created, row } = await changeCapabilityCatalog((rows) =>
    learnedSkillChange(rows, skill)
  );
  return {
    capability: publicCapability(row),
    created,
    loadName: runtimeSkillName(row.id, skill.name),
  };
}

function learnedSkillChange(
  rows: readonly CapabilityRow[],
  skill: LearnedSkill
): CatalogChange {
  const existing = rows.find(
    (capability) =>
      capability.kind === "skill" &&
      capability.name.toLowerCase() === skill.name
  );
  if (existing?.origin) {
    throw new CapabilityConflictError(
      `"${skill.name}" came from skills.sh. Pick another name for the learned skill.`
    );
  }
  if (existing && !skill.edit) {
    throw new CapabilityConflictError(
      `A skill named "${skill.name}" already exists. Pick another name, or propose an update to it.`
    );
  }
  const current = existing ? parseCapabilitySkills(existing.skills) : [];
  const previous = current.find((entry) => entry.name === skill.name);
  const learned = {
    content: skill.instructions,
    description: skill.description,
    files: previous?.files ?? {},
    name: skill.name,
  };
  const skills = previous
    ? current.map((entry) => (entry === previous ? learned : entry))
    : [...current, learned];
  const input: CapabilityInput = capabilityInputSchema.parse({
    description: existing?.description ?? skill.description,
    kind: "skill",
    name: existing?.name ?? skill.name,
    skills,
    ...(existing?.version ? { version: existing.version } : {}),
  });
  return existing ? { id: existing.id, update: input } : { create: input };
}
