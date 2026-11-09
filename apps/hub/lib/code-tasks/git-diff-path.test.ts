import { describe, expect, it } from "vitest";
import { parseGitDiffHeader } from "./git-diff-path";

describe("parseGitDiffHeader", () => {
  it("parses unquoted paths containing spaces", () => {
    expect(
      parseGitDiffHeader("diff --git a/src/old name.ts b/src/new name.ts")
    ).toEqual({
      path: "src/new name.ts",
      previousPath: "src/old name.ts",
    });
  });

  it("decodes quoted UTF-8 octal paths", () => {
    expect(
      parseGitDiffHeader(
        String.raw`diff --git "a/caf\303\251 file.ts" "b/caf\303\251 file.ts"`
      )
    ).toEqual({ path: "café file.ts", previousPath: "café file.ts" });
  });

  it("decodes Git C escapes and quoted backslashes", () => {
    expect(
      parseGitDiffHeader(
        String.raw`diff --git "a/old\t\n\r\b\f\v\a\\\".ts" "b/new\t\n\r\b\f\v\a\\\".ts"`
      )
    ).toEqual({
      path: 'new\t\n\r\b\f\v\x07\\".ts',
      previousPath: 'old\t\n\r\b\f\v\x07\\".ts',
    });
  });

  it("parses quoted renames", () => {
    expect(
      parseGitDiffHeader('diff --git "a/docs/old name.md" "b/docs/new name.md"')
    ).toEqual({
      path: "docs/new name.md",
      previousPath: "docs/old name.md",
    });
  });

  it("rejects malformed quoting, octal bytes, and UTF-8", () => {
    expect(
      parseGitDiffHeader(String.raw`diff --git "a/bad\400" "b/bad"`)
    ).toBeNull();
    expect(
      parseGitDiffHeader(String.raw`diff --git "a/bad\303\303" "b/bad"`)
    ).toBeNull();
    expect(parseGitDiffHeader('diff --git "a/bad" "b/bad')).toBeNull();
  });
});
