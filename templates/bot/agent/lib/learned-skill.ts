import { createHash } from "node:crypto";
import { z } from "zod";
import { type HubFetch, hubFetch } from "./hub";
import type { LearnedSkillInput } from "./learned-skill-input";

const savedResponse = z.object({
  capability: z.object({ id: z.uuid(), name: z.string().min(1).max(64) }),
  created: z.boolean(),
  loadName: z.string().min(1).max(80),
});

/** `edit`: the user approved an update of the skill saved under this name; otherwise a taken name is refused. */
export async function saveLearnedSkill(
  input: LearnedSkillInput & { edit: boolean },
  signal?: AbortSignal,
  fetcher: HubFetch = hubFetch
) {
  let response: Response;
  try {
    response = await fetcher("/api/bot/skills/learned", {
      body: JSON.stringify(input),
      method: "POST",
      signal,
    });
  } catch (error) {
    throw new Error("Busy is unavailable. The skill was not saved.", {
      cause: error,
    });
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z
      .object({ error: z.string().min(1).max(500) })
      .safeParse(body);
    throw new Error(
      error.success
        ? error.data.error
        : `The skill was not saved (HTTP ${response.status}).`
    );
  }
  const saved = savedResponse.safeParse(body);
  if (!saved.success) {
    throw new Error(
      "Busy returned an invalid response. The skill may not be saved."
    );
  }
  const digest = createHash("sha256")
    .update(`${saved.data.capability.id}\0${input.name}`)
    .digest("hex")
    .slice(0, 16);
  if (saved.data.loadName !== `s_${digest}_${input.name.slice(0, 44)}`) {
    throw new Error("Busy returned an unexpected skill name.");
  }
  return saved.data;
}
