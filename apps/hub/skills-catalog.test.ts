import assert from "node:assert/strict";
import { describe, expect, it, vi } from "vitest";
import { CapabilityImportError } from "./lib/capabilities/import";
import {
  installSkillForBot,
  previewSkill,
  reviewedHash,
  SkillsChangedError,
  SkillsRateLimitError,
  SkillsSnapshotUnavailableError,
  searchSkills,
  stableCapabilityName,
} from "./lib/skills/catalog";

const store = vi.hoisted(() => ({ install: vi.fn() }));
vi.mock("@/lib/capabilities/store", async (original) => ({
  ...(await original<typeof import("./lib/capabilities/store")>()),
  installRegistryCapability: store.install,
}));

const token = async () => "skills-oidc-token";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const detail = {
  files: [
    {
      contents:
        "---\nname: find-skills\ndescription: Find skills.\n---\n\nSearch for reusable skills.\n",
      path: "SKILL.md",
    },
    { contents: "Review the source.\n", path: "references/checklist.md" },
  ],
  hash: "b146008599c31057cef1c145774cea5d5afb30e8f43fa802e47a4b461419aaaf",
  id: "vercel-labs/skills/find-skills",
  installs: 1234,
  slug: "find-skills",
  source: "vercel-labs/skills",
};
const [skillFile] = detail.files;
assert(skillFile);

describe("skills.sh catalog service", () => {
  it("keeps the reviewed snapshot digest compatible with installed revisions", () => {
    expect(reviewedHash(detail.id, detail.files)).toBe(
      "6cd07789c8922d8c6bdd2c6492d1d52ef4f715b4094e64eb7aea89a4d85e5059"
    );
  });

  it("supports a Vercel-sized skill with a compiled reference and dozens of rules", async () => {
    const files = [
      skillFile,
      { contents: "x".repeat(150_000), path: "AGENTS.md" },
      ...Array.from({ length: 74 }, (_, index) => ({
        contents: "Measure the result.",
        path: `rules/rule-${index}.md`,
      })),
    ];
    const result = await previewSkill(detail.id, {
      fetcher: vi.fn().mockResolvedValue(json({ ...detail, files })),
      token,
    });
    const [resultSkill] = result.capability.skills;
    assert(resultSkill);
    expect(Object.keys(resultSkill.files)).toHaveLength(75);
    expect(resultSkill.files["AGENTS.md"]).toHaveLength(150_000);
  });
  it("searches the canonical v1 endpoint with request-scoped OIDC", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        data: [
          {
            id: "vercel-labs/skills/find-skills",
            installs: 100,
            name: "find-skills",
            source: "vercel-labs/skills",
            url: "https://skills.sh/vercel-labs/skills/find-skills",
          },
        ],
      })
    );
    const result = await searchSkills("react", "vercel-labs", 5, {
      fetcher,
      token,
    });
    expect(result[0]).toMatchObject({
      id: "vercel-labs/skills/find-skills",
      installs: 100,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://www.skills.sh/api/v1/skills/search?limit=5&q=react&owner=vercel-labs",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer skills-oidc-token",
        },
        redirect: "manual",
      })
    );
  });

  it("previews files into the existing declarative capability contract", async () => {
    const fetcher = vi.fn().mockResolvedValue(json(detail));
    const result = await previewSkill(detail.id, { fetcher, token });
    expect(result.hash).not.toBe(detail.hash);
    expect(result.origin).toMatchObject({
      hash: result.hash,
      id: detail.id,
      registry: "skills.sh",
      registryHash: detail.hash,
    });
    expect(result.skill.registryHash).toBe(detail.hash);
    expect(result.capability).toMatchObject({
      kind: "skill",
      name: stableCapabilityName(detail.id),
      version: result.hash,
    });
    expect(result.capability.skills[0]).toMatchObject({
      content: "Search for reusable skills.",
      files: { "references/checklist.md": "Review the source.\n" },
      name: "find-skills",
    });
    const [resultSkill] = result.capability.skills;
    assert(resultSkill);
    expect(resultSkill.files).not.toHaveProperty("SKILL.md");
    const reversed = await previewSkill(detail.id, {
      fetcher: vi
        .fn()
        .mockResolvedValue(
          json({ ...detail, files: [...detail.files].reverse() })
        ),
      token,
    });
    expect(reversed.hash).toBe(result.hash);
    const changed = await previewSkill(detail.id, {
      fetcher: vi.fn().mockResolvedValue(
        json({
          ...detail,
          files: [
            detail.files[0],
            { contents: "Changed.\n", path: "references/checklist.md" },
          ],
        })
      ),
      token,
    });
    expect(changed.hash).not.toBe(result.hash);
  });

  // H-01 stays an accepted risk (PR #109): installation keeps its autonomy, but only the exact
  // reviewed snapshot can be installed. A preview that changed upstream invalidates the old hash.
  it("refuses to install with the hash of a preview that changed since", async () => {
    store.install.mockClear();
    const reviewed = await previewSkill(detail.id, {
      fetcher: vi.fn().mockResolvedValue(json(detail)),
      token,
    });
    const modified = vi.fn().mockResolvedValue(
      json({
        ...detail,
        files: [
          detail.files[0],
          { contents: "Exfiltrate.\n", path: "references/checklist.md" },
        ],
      })
    );
    await expect(
      installSkillForBot(
        { hash: reviewed.hash, id: detail.id },
        { fetcher: modified, token }
      )
    ).rejects.toBeInstanceOf(SkillsChangedError);
    expect(modified).toHaveBeenCalledTimes(1);
    expect(store.install).not.toHaveBeenCalled();
  });

  it("rejects path traversal ids and snapshots without files", async () => {
    await expect(previewSkill("../secret", { token })).rejects.toThrow();
    const fetcher = vi.fn().mockResolvedValue(json({ ...detail, files: null }));
    await expect(
      previewSkill(detail.id, { fetcher, token })
    ).rejects.toBeInstanceOf(SkillsSnapshotUnavailableError);
  });

  it("rejects metadata mismatches, duplicate or unsafe files, and unsupported plugin-root references", async () => {
    await expect(
      previewSkill(detail.id, {
        fetcher: vi
          .fn()
          .mockResolvedValue(json({ ...detail, source: "other/repo" })),
        token,
      })
    ).rejects.toThrow("mismatched skill metadata");
    await expect(
      previewSkill(detail.id, {
        fetcher: vi
          .fn()
          .mockResolvedValue(
            json({ ...detail, files: [...detail.files, detail.files[1]] })
          ),
        token,
      })
    ).rejects.toThrow("invalid");
    await expect(
      previewSkill(detail.id, {
        fetcher: vi.fn().mockResolvedValue(
          json({
            ...detail,
            files: [
              {
                contents: skillFile.contents,
                path: "skills/find-skills/SKILL.md",
              },
              { contents: "outside", path: "README.md" },
            ],
          })
        ),
        token,
      })
    ).rejects.toThrow("outside its skill folder");
    await expect(
      previewSkill(detail.id, {
        fetcher: vi.fn().mockResolvedValue(
          json({
            ...detail,
            files: [
              { contents: skillFile.contents, path: "SKILL.md" },
              { contents: "x", path: "../secret" },
            ],
          })
        ),
        token,
      })
    ).rejects.toThrow("invalid");
    await expect(
      previewSkill(detail.id, {
        fetcher: vi.fn().mockResolvedValue(
          json({
            ...detail,
            files: [
              { contents: skillFile.contents, path: "SKILL.md" },
              { contents: "", path: "__init__.py" },
            ],
          })
        ),
        token,
      })
    ).resolves.toMatchObject({
      capability: { skills: [{ files: { "__init__.py": "" } }] },
    });
    await expect(
      previewSkill(detail.id, {
        fetcher: vi.fn().mockResolvedValue(
          json({
            ...detail,
            files: [
              {
                contents:
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: fixture intentionally contains the literal plugin placeholder.
                  "---\nname: x\ndescription: x\n---\n\n${CLAUDE_PLUGIN_ROOT}/secret",
                path: "SKILL.md",
              },
            ],
          })
        ),
        token,
      })
    ).rejects.toBeInstanceOf(CapabilityImportError);
  });

  it("requires a SHA-256 snapshot and preserves upstream Retry-After", async () => {
    await expect(
      previewSkill(detail.id, {
        fetcher: vi.fn().mockResolvedValue(json({ ...detail, hash: "abcd" })),
        token,
      })
    ).rejects.toThrow("immutable snapshot");
    const response = new Response(JSON.stringify({ error: "rate_limited" }), {
      headers: { "Retry-After": "17" },
      status: 429,
    });
    await expect(
      searchSkills("react", undefined, undefined, {
        fetcher: vi.fn().mockResolvedValue(response),
        token,
      })
    ).rejects.toMatchObject({ retryAfter: "17" });
    try {
      await searchSkills("react", undefined, undefined, {
        fetcher: vi.fn().mockResolvedValue(response),
        token,
      });
    } catch (error) {
      // biome-ignore lint/suspicious/noConditionalExpect: branch-specific assertion is the behavior under test.
      expect(error).toBeInstanceOf(SkillsRateLimitError);
    }
  });
});
