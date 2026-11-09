import { describe, expect, it } from "vitest";
import {
  CapabilityImportError,
  parseCapabilityFiles,
  parseCapabilityJson,
} from "./import";

function file(
  path: string,
  source: string | Uint8Array
): File & { webkitRelativePath: string } {
  const value = new File([source as BlobPart], path.split("/").pop() || path, {
    type: "text/plain",
  }) as File & { webkitRelativePath: string };
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}

describe("capability importer", () => {
  it("parses an Agent Skills markdown file and preserves supporting files", async () => {
    const result = await parseCapabilityFiles(
      [
        file(
          "review/SKILL.md",
          "---\ndescription: Review contracts carefully.\n---\n\n1. Read the agreement.\n2. Flag unclear obligations."
        ),
        file("review/references/checklist.md", "- Parties\n- Dates"),
      ],
      "skill"
    );
    expect(result).toMatchObject({
      description: "Review contracts carefully.",
      kind: "skill",
      name: "review",
    });
    expect(result.skills[0]).toMatchObject({
      content: "1. Read the agreement.\n2. Flag unclear obligations.",
      files: { "references/checklist.md": "- Parties\n- Dates" },
      name: "review",
    });
  });

  it("imports Claude and Codex plugin manifests with configured skill paths", async () => {
    const result = await parseCapabilityFiles(
      [
        file(
          "contract-plugin/.claude-plugin/plugin.json",
          JSON.stringify({
            description: "Contract workflows.",
            name: "contracts",
            skills: ["./skills/review"],
            version: "1.2.0",
          })
        ),
        file(
          "contract-plugin/skills/review/SKILL.md",
          "---\ndescription: Review contracts.\n---\nReview the text."
        ),
        file("contract-plugin/skills/review/references/rules.md", "Rules"),
        file("contract-plugin/.mcp.json", JSON.stringify({ mcpServers: {} })),
      ],
      "plugin"
    );
    expect(result).toMatchObject({
      kind: "plugin",
      name: "contracts",
      skills: [{ files: { "references/rules.md": "Rules" }, name: "review" }],
      version: "1.2.0",
    });

    const codex = await parseCapabilityFiles(
      [
        file(
          ".codex-plugin/plugin.json",
          JSON.stringify({ name: "codex-pack", skills: "./skills" })
        ),
        file(
          "skills/release/SKILL.md",
          "---\ndescription: Release checklist.\n---\nCheck the release."
        ),
      ],
      "plugin"
    );
    expect(codex.skills[0]?.name).toBe("release");

    const portable = await parseCapabilityFiles(
      [
        file(
          "portable/plugin.json",
          JSON.stringify({ name: "portable", skills: "./skills/" })
        ),
        file(
          "portable/skills/release/SKILL.md",
          "---\ndescription: Release checklist.\n---\nCheck the release."
        ),
      ],
      "plugin"
    );
    expect(portable.name).toBe("portable");

    const root = await parseCapabilityFiles(
      [
        file("plugin.json", JSON.stringify({ name: "root-pack" })),
        file("skills/release/SKILL.md", "Check the release."),
      ],
      "plugin"
    );
    expect(root).toMatchObject({
      kind: "plugin",
      name: "root-pack",
      skills: [{ name: "release" }],
    });
  });

  it("rejects unsupported plugin components instead of silently dropping them", async () => {
    await expect(
      parseCapabilityFiles(
        [
          file(
            ".claude-plugin/plugin.json",
            JSON.stringify({ hooks: { PostToolUse: [] }, name: "unsafe" })
          ),
          file("skills/a/SKILL.md", "Instructions"),
        ],
        "plugin"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/unsupported components: hooks/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            ".claude-plugin/plugin.json",
            JSON.stringify({ name: "unsafe", skills: ["../outside"] })
          ),
          file("skills/a/SKILL.md", "Instructions"),
        ],
        "plugin"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/unsafe/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            ".claude-plugin/plugin.json",
            JSON.stringify({ name: "unsafe" })
          ),
          file("skills/a/SKILL.md", "Instructions"),
          file(
            ".mcp.json",
            JSON.stringify({
              mcpServers: { private: { url: "https://example.test" } },
            })
          ),
        ],
        "plugin"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/mcpServers/u);
    await expect(
      parseCapabilityFiles(
        [
          file("portable/plugin.json", JSON.stringify({ name: "unsafe" })),
          file("portable/skills/a/SKILL.md", "Instructions"),
          file("portable/hooks/run.sh", "#!/bin/sh"),
        ],
        "plugin"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/hooks/u);
  });

  it("rejects binary files, duplicate names and plugin-root placeholders", async () => {
    await expect(
      parseCapabilityFiles(
        [file("SKILL.md", new Uint8Array([0, 1, 2]))],
        "skill"
      )
    ).rejects.toBeInstanceOf(CapabilityImportError);
    expect(
      () =>
        parseCapabilityJson(
          JSON.stringify({
            description: "Bundle",
            kind: "plugin",
            name: "bundle",
            skills: [
              { content: "A", description: "A", files: {}, name: "same" },
              { content: "B", description: "B", files: {}, name: "same" },
            ],
          })
        )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).toThrow(/Duplicate skill name/u);
    await expect(
      parseCapabilityFiles(
        [
          // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture intentionally contains the literal plugin placeholder.
          file("SKILL.md", "Use ${CLAUDE_PLUGIN_ROOT}/references/checklist.md"),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/plugin-root/u);
  });

  it("rejects unsafe support paths", () => {
    expect(
      () =>
        parseCapabilityJson(
          JSON.stringify({
            description: "Bundle",
            kind: "plugin",
            name: "bundle",
            skills: [
              {
                content: "A",
                description: "A",
                files: { "../secret.md": "no" },
                name: "safe",
              },
            ],
          })
        )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).toThrow(/Unsafe supporting file path/u);
  });

  it("preserves folded descriptions and rejects skill settings Eve cannot enforce", async () => {
    const result = await parseCapabilityFiles(
      [
        file(
          "review/SKILL.md",
          "---\nname: review\ndescription: >-\n  Review claims\n  against sources.\n---\nCheck the evidence."
        ),
      ],
      "skill"
    );
    expect(result.description).toBe("Review claims against sources.");
    await expect(
      parseCapabilityFiles(
        [
          file(
            "review/SKILL.md",
            "---\nname: review\nallowed-tools: Read\n---\nCheck the evidence."
          ),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/unsupported settings: allowed-tools/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            "review/SKILL.md",
            "---\nname: review\ndisable-model-invocation: true\n---\nCheck the evidence."
          ),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/disable-model-invocation/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            "review/SKILL.md",
            "---\nname: review\nallowed-tools:\n  - Read\n  - Grep\n---\nCheck the evidence."
          ),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/unsupported settings: allowed-tools/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            "review/SKILL.md",
            "---\nname: review\nhooks:\n  PostToolUse:\n    - command\n---\nCheck the evidence."
          ),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/unsupported settings: hooks/u);
    await expect(
      parseCapabilityFiles(
        [
          file(
            "review/SKILL.md",
            "---\nname: review\ndisable-model-invocation: true # explicit-only\n---\nCheck the evidence."
          ),
        ],
        "skill"
      )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).rejects.toThrow(/disable-model-invocation/u);
  });

  it.each(["hooks.json", "mcp.json"])(
    "detects the default portable component %s",
    async (path) => {
      await expect(
        parseCapabilityFiles(
          [
            file("portable/plugin.json", JSON.stringify({ name: "portable" })),
            file("portable/skills/review/SKILL.md", "Check the evidence."),
            file(
              `portable/${path}`,
              JSON.stringify({
                mcpServers: { docs: { url: "https://example.test" } },
              })
            ),
          ],
          "plugin"
        )
        // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
      ).rejects.toThrow(/unsupported components/u);
    }
  );

  it("applies the same UTF-8 and aggregate limits before showing an install preview", () => {
    const skill = {
      content: "Review claims.",
      description: "Review",
      files: {},
      name: "review",
    };
    expect(() =>
      parseCapabilityJson(
        JSON.stringify({
          description: "Bundle",
          kind: "plugin",
          name: "bundle",
          skills: [{ ...skill, description: "é".repeat(1001) }],
        })
      )
    ).toThrow();
    expect(
      () =>
        parseCapabilityJson(
          JSON.stringify({
            description: "Bundle",
            kind: "plugin",
            name: "bundle",
            skills: Array.from({ length: 4 }, (_, index) => ({
              ...skill,
              content: "x".repeat(100_000),
              name: `review-${index}`,
            })),
          })
        )
      // biome-ignore lint/performance/useTopLevelRegex: Test matcher literal is local to this assertion.
    ).toThrow(/content exceeds/u);
  });
});
