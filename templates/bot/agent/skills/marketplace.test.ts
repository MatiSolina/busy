import { describe, expect, it, vi } from "vitest";
import { defined } from "../test-utils";
import {
  listMarketplaceSkills,
  MAX_SKILL_CONTENT_BYTES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILLS,
  parseMarketplaceCapabilities,
  resolveMarketplaceSkills,
} from "./marketplace";

const id = "1234567890abcdef";
const skill = (overrides: Record<string, unknown> = {}) => ({
  content: "Use primary sources before answering.",
  description: "Research workflow.",
  files: { "references/checklist.md": "- Find the source.\n" },
  name: `s_${id}_research`,
  ...overrides,
});

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

describe("skills marketplace connection", () => {
  it("loads enabled skills and maps them to named Eve skill definitions", async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ skills: [skill()] }));

    const definitions = await resolveMarketplaceSkills(fetcher);

    expect(Object.keys(definitions)).toEqual([`s_${id}_research`]);
    expect(definitions[`s_${id}_research`]).toMatchObject({
      content: "Use primary sources before answering.",
      description: "Research workflow.",
      files: { "references/checklist.md": "- Find the source.\n" },
    });
    expect(fetcher).toHaveBeenCalledWith("/api/bot/capabilities");
  });

  it("fetches on every resolution so changes are visible in an existing session", async () => {
    const first = skill();
    const second = skill({ name: `s_${id}_writing` });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ skills: [first] }))
      .mockResolvedValueOnce(json({ skills: [second] }));

    const initial = await resolveMarketplaceSkills(fetcher);
    const updated = await resolveMarketplaceSkills(fetcher);

    expect(Object.keys(initial)).toEqual([`s_${id}_research`]);
    expect(Object.keys(updated)).toEqual([`s_${id}_writing`]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts the bot-wide skill aggregate instead of treating 16 as a global limit", () => {
    const many = Array.from({ length: 17 }, (_, i) =>
      skill({ name: `s_${id}_s${i}` })
    );
    expect(parseMarketplaceCapabilities({ skills: many })).toHaveLength(17);
  });

  it("fails closed when the hub is unavailable or returns malformed JSON", async () => {
    await expect(
      listMarketplaceSkills(
        vi.fn().mockResolvedValue(new Response("down", { status: 503 }))
      )
    ).rejects.toThrow("Skills marketplace is unavailable (HTTP 503)");
    await expect(
      listMarketplaceSkills(
        vi.fn().mockRejectedValue(new Error("network down"))
      )
    ).rejects.toThrow("Skills marketplace is unavailable");
    await expect(
      listMarketplaceSkills(
        vi.fn().mockResolvedValue(new Response("not json", { status: 200 }))
      )
    ).rejects.toThrow("Skills marketplace returned an invalid response");
    await expect(
      resolveMarketplaceSkills(
        vi.fn().mockResolvedValue(json({ skills: [{ nope: true }] }))
      )
    ).rejects.toThrow("Skills marketplace returned an invalid skill");
  });

  it("rejects duplicate or unsafe skill names", () => {
    expect(() =>
      parseMarketplaceCapabilities({ skills: [skill(), skill()] })
    ).toThrow("duplicate skill");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [skill({ name: "research/unsafe" })],
      })
    ).toThrow("invalid skill");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [skill({ name: `s_${id}_../research` })],
      })
    ).toThrow("invalid skill");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [skill({ name: `s_${id}_${"x".repeat(60)}` })],
      })
    ).toThrow("invalid skill");
  });

  it("rejects unsafe skill package file paths and generated SKILL.md", () => {
    for (const path of [
      "../secret.txt",
      "references/../../secret.txt",
      "/tmp/secret.txt",
      "C:\\secret.txt",
      "references\\secret.txt",
      "SKILL.md",
      "skill.md",
      "references//secret.txt",
      "references/__proto__/secret.txt",
      "references/My File.txt",
    ]) {
      expect(() =>
        parseMarketplaceCapabilities({
          skills: [skill({ files: { [path]: "secret" } })],
        })
      ).toThrow("invalid file");
    }
  });

  it("enforces response and package size limits", () => {
    expect(() =>
      parseMarketplaceCapabilities({
        skills: Array.from({ length: MAX_SKILLS + 1 }, (_, i) =>
          skill({ name: `s_${id}_s${i}` })
        ),
      })
    ).toThrow("invalid response");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [skill({ content: "x".repeat(MAX_SKILL_CONTENT_BYTES + 1) })],
      })
    ).toThrow("oversized skill");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [
          skill({
            files: Object.fromEntries(
              Array.from({ length: MAX_SKILL_FILES + 1 }, (_, i) => [
                `ref${i}.md`,
                "x",
              ])
            ),
          }),
        ],
      })
    ).toThrow("too many files");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [
          skill({
            files: {
              "references/large.txt": "x".repeat(MAX_SKILL_FILE_BYTES + 1),
            },
          }),
        ],
      })
    ).toThrow("oversized file");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: Array.from({ length: 12 }, (_, i) =>
          skill({ content: "x".repeat(190_000), name: `s_${id}_s${i}` })
        ),
      })
    ).toThrow("too much content");
    expect(() =>
      parseMarketplaceCapabilities({
        skills: [skill({ content: "é".repeat(100_001) })],
      })
    ).toThrow("oversized skill");
    expect(
      parseMarketplaceCapabilities({
        skills: [skill({ content: "é".repeat(100_000) })],
      })
    ).toHaveLength(1);
  });

  it("accepts the expanded supporting-file ceiling", () => {
    const files = Object.fromEntries(
      Array.from({ length: MAX_SKILL_FILES }, (_, i) => [
        `references/ref-${i}.md`,
        "x",
      ])
    );
    expect(
      parseMarketplaceCapabilities({ skills: [skill({ files })] })
    ).toHaveLength(1);
  });

  it("accepts empty Python package markers from skills.sh snapshots", () => {
    expect(
      defined(
        parseMarketplaceCapabilities({
          skills: [skill({ files: { "__init__.py": "" } })],
        })[0]
      ).files
    ).toEqual({ "__init__.py": "" });
  });
});
