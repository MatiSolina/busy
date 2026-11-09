import { describe, expect, it, it as test, vi } from "vitest";
import type { HubFetch } from "./hub";
import {
  findCatalogSkills,
  installCatalogSkill,
  previewCatalogSkill,
} from "./skill-catalog";

const id = "vercel-labs/agent-skills/vercel-react-best-practices";
const hash = "a".repeat(64);
const SKILL_NAME_RE = /^s_[a-f0-9]{16}_vercel-react-best-practices$/u;
const entry = {
  id,
  installs: 200_000,
  name: "React best practices",
  slug: "vercel-react-best-practices",
  source: "vercel-labs/agent-skills",
};
const skill = {
  content: "Read the rules.",
  description: "Review React",
  files: { "rules/performance.md": "Measure before optimizing." },
  name: "vercel-react-best-practices",
};

test("searches through the authenticated hub and projects safe metadata only", async () => {
  const fetcher = vi.fn<HubFetch>().mockResolvedValue(
    Response.json({
      skills: [
        { ...entry, token: "must-not-return", url: "javascript:alert(1)" },
      ],
    })
  );
  const result = await findCatalogSkills(
    "React performance",
    "vercel-labs",
    undefined,
    fetcher
  );
  expect(fetcher).toHaveBeenCalledWith(
    "/api/bot/skills/search?q=React+performance&limit=20&owner=vercel-labs",
    { signal: undefined }
  );
  expect(result.skills[0]).toEqual({
    ...entry,
    url: `https://skills.sh/${id}`,
  });
});

test("previews the reviewed hash, instructions and supporting files", async () => {
  const fetcher = vi.fn<HubFetch>().mockResolvedValue(
    Response.json({
      capability: { skills: [skill] },
      hash,
      internal: "omit",
      skill: entry,
    })
  );
  expect(await previewCatalogSkill(id, undefined, fetcher)).toEqual({
    files: skill.files,
    hash,
    instructions: skill.content,
    skill: { ...entry, url: `https://skills.sh/${id}` },
  });
});

test("installs the exact reviewed revision and returns an Eve load name", async () => {
  const capabilityId = "11111111-1111-4111-8111-111111111111";
  const fetcher = vi.fn<HubFetch>().mockResolvedValue(
    Response.json({
      capability: {
        enabled: true,
        id: capabilityId,
        name: "react-package",
        skills: [skill],
      },
      hash,
      reused: true,
    })
  );
  const result = await installCatalogSkill(id, hash, undefined, fetcher);
  expect(fetcher).toHaveBeenCalledWith("/api/bot/skills", {
    body: JSON.stringify({ hash, id }),
    method: "POST",
    signal: undefined,
  });
  expect(result).toMatchObject({
    alreadyInstalled: true,
    capabilityId,
    loadName: expect.stringMatching(SKILL_NAME_RE),
    name: skill.name,
  });
});

describe("catalog failures", () => {
  it("reports a stale preview and keeps invalid successful responses from claiming installation", async () => {
    await expect(
      installCatalogSkill(
        id,
        hash,
        undefined,
        vi
          .fn<HubFetch>()
          .mockResolvedValue(
            Response.json({ error: "Preview it again." }, { status: 409 })
          )
      )
    ).rejects.toThrow("Preview it again.");
    await expect(
      installCatalogSkill(
        id,
        hash,
        undefined,
        vi.fn<HubFetch>().mockResolvedValue(Response.json({ ok: true }))
      )
    ).rejects.toThrow("invalid response");
  });

  it("does not expose raw transport errors or return a different preview", async () => {
    await expect(
      findCatalogSkills(
        "react",
        undefined,
        undefined,
        vi.fn<HubFetch>().mockRejectedValue(new Error("secret token"))
      )
    ).rejects.toThrow("unavailable");
    await expect(
      previewCatalogSkill(
        id,
        undefined,
        vi.fn<HubFetch>().mockResolvedValue(
          Response.json({
            capability: { skills: [skill] },
            hash,
            skill: { ...entry, id: "other/repo/skill" },
          })
        )
      )
    ).rejects.toThrow("different skill");
  });
});
