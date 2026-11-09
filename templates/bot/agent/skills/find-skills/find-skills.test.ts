import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const here = (path: string) => new URL(path, import.meta.url);
const text = (path: string) => readFileSync(here(path), "utf8");
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const COMMIT_RE = /^[0-9a-f]{40}$/u;

describe("built-in find-skills provenance", () => {
  const main = text("./SKILL.md");
  const upstream = text("./references/upstream.md");
  const license = text("./references/LICENSE");
  const provenance = JSON.parse(
    text("../../../../../docs/provenance/find-skills.json")
  ) as {
    source: { commit: string; path: string; sha256: string };
    license: { name: string; sha256: string };
    adaptation: { toolReplacement: string[]; packageExecution: string };
  };

  it("pins the upstream source and keeps a complete local copy", () => {
    expect(provenance.source.commit).toMatch(COMMIT_RE);
    expect(provenance.source.path).toBe("skills/find-skills/SKILL.md");
    expect(provenance.source.sha256).toBe(sha256(upstream));
    expect(provenance.license.name).toBe("MIT");
    expect(provenance.license.sha256).toBe(sha256(license));
    expect(upstream).toContain("# Find Skills");
    expect(upstream).toContain("npx skills find");
  });

  it("adapts package-manager actions to Busy tools and treats packages as declarative", () => {
    expect(provenance.adaptation.toolReplacement).toEqual([
      "find_skills",
      "preview_skill",
      "install_skill",
    ]);
    expect(provenance.adaptation.packageExecution).toBe("disabled");
    expect(main).toContain("`find_skills({ query, owner? })`");
    expect(main).toContain("`preview_skill({ id })`");
    expect(main).toContain("`install_skill({ id, hash })`");
    expect(main).not.toContain("npx skills");
  });
});
