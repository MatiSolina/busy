import { createHash } from "node:crypto";
import { z } from "zod";
import { type HubFetch, hubFetch } from "./hub";

export const skillId = z
  .string()
  .min(3)
  .max(260)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*){1,2}$/u);
export const snapshotHash = z.string().regex(/^[a-f0-9]{64}$/iu);

const catalogEntry = z.object({
  id: skillId,
  installs: z.number().int().nonnegative(),
  name: z.string().min(1).max(160),
  slug: z.string().min(1).max(128),
  source: z.string().min(1).max(256),
});
const skillPackage = z.object({
  content: z.string().min(1).max(200_000),
  description: z.string().min(1).max(2000),
  files: z.record(z.string(), z.string().max(256 * 1024)),
  name: z.string().min(1).max(64),
});
const searchResponse = z.object({ skills: z.array(catalogEntry).max(50) });
const previewResponse = z.object({
  capability: z.object({ skills: z.array(skillPackage).length(1) }),
  hash: snapshotHash,
  skill: catalogEntry,
});
const installResponse = z.object({
  capability: z.object({
    enabled: z.boolean(),
    id: z.uuid(),
    name: z.string().min(1).max(64),
    skills: z.array(z.object({ name: z.string().min(1).max(64) })).length(1),
  }),
  hash: snapshotHash,
  reused: z.boolean(),
});

async function catalogRequest(
  path: string,
  init: RequestInit,
  fetcher: HubFetch
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(path, init);
  } catch (error) {
    throw new Error("The skills catalog is unavailable. Try again later.", {
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
        : `The skills catalog request failed (HTTP ${response.status}).`
    );
  }
  return body;
}

function parsed<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new Error("The skills catalog returned an invalid response.");
  }
  return result.data;
}

export async function findCatalogSkills(
  query: string,
  owner?: string,
  signal?: AbortSignal,
  fetcher: HubFetch = hubFetch
) {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", "20");
  if (owner) {
    params.set("owner", owner);
  }
  const body = parsed(
    searchResponse,
    await catalogRequest(
      `/api/bot/skills/search?${params}`,
      { signal },
      fetcher
    )
  );
  return {
    skills: body.skills.map((entry) => ({
      ...entry,
      url: `https://skills.sh/${entry.id}`,
    })),
  };
}

export async function previewCatalogSkill(
  id: string,
  signal?: AbortSignal,
  fetcher: HubFetch = hubFetch
) {
  const body = parsed(
    previewResponse,
    await catalogRequest(
      `/api/bot/skills/preview?${new URLSearchParams({ id })}`,
      { signal },
      fetcher
    )
  );
  if (body.skill.id !== id) {
    throw new Error("The skills catalog returned a different skill.");
  }
  const [skill] = body.capability.skills;
  if (!skill) {
    throw new Error("The skills catalog returned no skill content.");
  }
  return {
    files: skill.files,
    hash: body.hash,
    instructions: skill.content,
    skill: { ...body.skill, url: `https://skills.sh/${body.skill.id}` },
  };
}

export async function installCatalogSkill(
  id: string,
  hash: string,
  signal?: AbortSignal,
  fetcher: HubFetch = hubFetch
) {
  const body = parsed(
    installResponse,
    await catalogRequest(
      "/api/bot/skills",
      {
        body: JSON.stringify({ hash, id }),
        method: "POST",
        signal,
      },
      fetcher
    )
  );
  if (
    body.hash.toLowerCase() !== hash.toLowerCase() ||
    !body.capability.enabled
  ) {
    throw new Error("The selected skill revision was not installed.");
  }
  const [skill] = body.capability.skills;
  if (!skill) {
    throw new Error("The selected skill revision contained no skill.");
  }
  const { name } = skill;
  const { id: capabilityId } = body.capability;
  const digest = createHash("sha256")
    .update(`${capabilityId}\0${name}`)
    .digest("hex")
    .slice(0, 16);
  return {
    alreadyInstalled: body.reused,
    capabilityId,
    hash: body.hash,
    loadName: `s_${digest}_${name.slice(0, 44)}`,
    name,
    next: "The skill is available on the next model call. Load it with eve__skill using loadName.",
  };
}
