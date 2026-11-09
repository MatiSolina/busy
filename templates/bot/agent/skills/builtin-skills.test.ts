import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const SKILLS = [
  "send-on-behalf",
  "no-connector-fallback",
  "sign-in",
  "routines",
  "skill-authoring",
  "purchases",
  "busy-app-ui",
  "computer-troubleshooting",
];
const FORBIDDEN = ["Mati", "Grok", "Cursor", "SendToUser"];
const FRONTMATTER_RE = /^---\n(?<front>[\s\S]*?)\n---\n/u;
const field = (front: string, key: string) =>
  new RegExp(`^${key}:\\s*(?<value>.+)$`, "mu")
    .exec(front)
    ?.groups?.value?.trim();

describe.each(SKILLS)("built-in skill %s", (name) => {
  const text = readFileSync(
    new URL(`./${name}/SKILL.md`, import.meta.url),
    "utf8"
  );
  const front = FRONTMATTER_RE.exec(text)?.groups?.front ?? "";

  test("has frontmatter matching its folder and a description", () => {
    expect(field(front, "name")).toBe(name);
    expect(field(front, "description")?.length ?? 0).toBeGreaterThan(20);
  });

  test("stays small and user-agnostic", () => {
    expect(Buffer.byteLength(text)).toBeLessThan(8192);
    for (const word of FORBIDDEN) {
      expect(text).not.toContain(word);
    }
  });
});
