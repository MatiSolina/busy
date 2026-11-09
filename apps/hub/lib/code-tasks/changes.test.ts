import { describe, expect, it, it as test } from "vitest";
import { publicTaskDiff } from "./changes";
import type { PublicCodeTask } from "./types";

const task = (execution: Record<string, unknown>): PublicCodeTask => ({
  agentName: "Busy",
  appliedInstructionVersion: 1,
  billing: "token-pass",
  botId: "bot",
  branch: "codex/busy-task",
  commitSha: "c".repeat(40),
  createdAt: "2026-01-01T00:00:00.000Z",
  durableSessionId: "session",
  error: null,
  execution,
  finishedAt: null,
  goal: "Inspect the repository",
  id: "11111111-1111-4111-8111-111111111111",
  instructionVersion: 1,
  lastStreamCursor: 1,
  model: "model",
  phase: null,
  prUrl: "https://github.com/acme/repo/pull/1",
  repository: { baseBranch: "main", fullName: "acme/repo", id: "repo" },
  revision: 1,
  status: "ready",
  summary: "Done",
  title: "Inspect",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("publicTaskDiff", () => {
  it("returns file-oriented change sections and preserves deleted files", () => {
    const result = publicTaskDiff(
      task({
        diff: [
          "diff --git a/src/new.ts b/src/new.ts",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/src/new.ts",
          "@@ -0,0 +1 @@",
          "+export const value = 1;",
          "diff --git a/src/old.ts b/src/old.ts",
          "deleted file mode 100644",
          "--- a/src/old.ts",
          "+++ /dev/null",
          "@@ -1 +0,0 @@",
          "-old",
        ].join("\n"),
        files: ["src/new.ts", "src/old.ts"],
      })
    );
    expect(result.files).toEqual([
      expect.objectContaining({
        additions: 1,
        deletions: 0,
        path: "src/new.ts",
        status: "added",
      }),
      expect.objectContaining({
        additions: 0,
        deletions: 1,
        path: "src/old.ts",
        status: "deleted",
      }),
    ]);
    expect(result.truncated).toBe(false);
  });

  it("redacts credentials in captured patches", () => {
    const result = publicTaskDiff(
      task({
        diff: "diff --git a/a b/a\n+const token = 'ghp_secret';\nAuthorization: Bearer ghp_secret",
        files: ["a"],
      })
    );
    expect(result.files[0]?.patch).toContain("[redacted credential]");
    expect(result.files[0]?.patch).toContain("[redacted authorization]");
  });

  it("uses a legacy single-file patch when the git header is absent", () => {
    const result = publicTaskDiff(
      task({ diff: "@@ -1 +1,2 @@\n-old\n+new\n+line", files: ["README.md"] })
    );
    expect(result.files[0]).toMatchObject({
      additions: 2,
      deletions: 1,
      patch: "@@ -1 +1,2 @@\n-old\n+new\n+line",
    });
  });

  it("marks the persisted 100k capture limit as truncated", () => {
    const result = publicTaskDiff(
      task({
        diff: "x".repeat(100_000),
        files: ["large.txt"],
      })
    );
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.patch).toHaveLength(100_000);
  });
});

test("matches quoted Git UTF-8 paths alongside other changed files", () => {
  const result = publicTaskDiff(
    task({
      diff: [
        'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
        '--- "a/caf\\303\\251.ts"',
        '+++ "b/caf\\303\\251.ts"',
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/plain.ts b/plain.ts",
        "--- a/plain.ts",
        "+++ b/plain.ts",
        "@@ -0,0 +1 @@",
        "+plain",
      ].join("\n"),
      files: ["café.ts", "plain.ts"],
    })
  );
  expect(result.files).toHaveLength(2);
  expect(result.files[0]).toMatchObject({
    additions: 1,
    deletions: 1,
    path: "café.ts",
  });
  expect(result.files[0]?.patch).toContain("+new");
  expect(result.files[1]).toMatchObject({
    additions: 1,
    deletions: 0,
    path: "plain.ts",
  });
});

test("counts changed code that resembles file headers without changing file status", () => {
  const result = publicTaskDiff(
    task({
      diff: "diff --git a/counter.ts b/counter.ts\n--- a/counter.ts\n+++ b/counter.ts\n@@ -1,2 +1,2 @@\n---counter;\n+++counter;\n--- /dev/null\n+++ /dev/null\n",
      files: ["counter.ts"],
    })
  );
  expect(result.files[0]).toMatchObject({
    additions: 2,
    deletions: 2,
    path: "counter.ts",
    status: "modified",
  });
});
