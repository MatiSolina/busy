import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  MAX_SUPPORT_FILE_BYTES,
  parseCapabilityInput,
  parseCapabilityPatch,
} from "./lib/capabilities/validation";

const skill = {
  content: "Use primary sources and state uncertainty.",
  description: "Research unfamiliar topics.",
  files: { "references/checklist.md": "- Find the source\n" },
  name: "research",
};

const input = () => ({
  description: "Research tools",
  kind: "plugin" as const,
  name: "research-kit",
  skills: [skill],
  version: "1.0.0",
});

describe("capability validation", () => {
  it("accepts a declarative plugin and the enabled-only patch", () => {
    expect(parseCapabilityInput(input())).toMatchObject({
      name: "research-kit",
      skills: [skill],
    });
    expect(parseCapabilityPatch({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it.each([
    ["eve", "reserved capability name"],
    ["eve__skill", "reserved capability prefix"],
  ])("rejects %s (%s)", (name) => {
    expect(() => parseCapabilityInput({ ...input(), name })).toThrow();
  });

  it.each([
    "../secret.md",
    "/tmp/secret.md",
    "..\\secret.md",
    "constructor/value.md",
  ])('rejects unsafe file path "%s"', (path) => {
    expect(() =>
      parseCapabilityInput({
        ...input(),
        skills: [{ ...skill, files: { [path]: "x" } }],
      })
    ).toThrow();
  });

  it("rejects unknown fields and duplicate skill names", () => {
    expect(() => parseCapabilityInput({ ...input(), extra: true })).toThrow();
    expect(() =>
      parseCapabilityInput({ ...input(), skills: [skill, skill] })
    ).toThrow();
  });

  it("rejects whitespace-only instructions and enforces UTF-8 byte limits", () => {
    expect(() =>
      parseCapabilityInput({
        ...input(),
        skills: [{ ...skill, content: " \n\t" }],
      })
    ).toThrow();
    expect(() =>
      parseCapabilityInput({
        ...input(),
        skills: [{ ...skill, description: "  " }],
      })
    ).toThrow();
    expect(() =>
      parseCapabilityInput({
        ...input(),
        skills: [{ ...skill, content: "é".repeat(100_001) }],
      })
    ).toThrow();
    expect(() =>
      parseCapabilityInput({
        ...input(),
        skills: [
          {
            ...skill,
            files: {
              "references/large.txt": "é".repeat(
                MAX_SUPPORT_FILE_BYTES / 2 + 1
              ),
            },
          },
        ],
      })
    ).toThrow();
  });

  it("accepts a compiled reference document over 100 KiB within the package budget", () => {
    const value = parseCapabilityInput({
      ...input(),
      skills: [{ ...skill, files: { "AGENTS.md": "x".repeat(150_000) } }],
    });
    const [parsedSkill] = value.skills;
    assert(parsedSkill);
    expect(parsedSkill.files["AGENTS.md"]).toHaveLength(150_000);
  });

  it("preserves newlines in supporting files", () => {
    const value = parseCapabilityInput({
      ...input(),
      skills: [
        {
          ...skill,
          files: { "references/checklist.md": "line one\nline two\n" },
        },
      ],
    });
    const [parsedSkill] = value.skills;
    assert(parsedSkill);
    expect(parsedSkill.files["references/checklist.md"]).toBe(
      "line one\nline two\n"
    );
  });
});
