// @vitest-environment happy-dom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  CodeTaskChanges,
  parseDiffLines,
} from "@/components/code-task-changes";
import type { PublicCodeTask } from "@/lib/code-tasks/types";
import { installFakes, json } from "./components.test-helpers";

const task: PublicCodeTask = {
  agentName: null,
  appliedInstructionVersion: 1,
  billing: "gateway",
  botId: "bot-1",
  branch: "codex/task-1",
  commitSha: null,
  createdAt: "2026-11-03T12:00:00Z",
  durableSessionId: null,
  error: null,
  execution: {
    diff: "@@ -1 +1 @@\n-old\n+new",
    files: ["src/auth.ts"],
  },
  finishedAt: null,
  goal: "Keep the redirect query string.",
  id: "task-1",
  instructionVersion: 1,
  lastStreamCursor: 1,
  model: "openai/gpt-6.1-sol",
  phase: "editing",
  prUrl: null,
  repository: { baseBranch: "main", fullName: "acme/app", id: "repo-1" },
  revision: 1,
  status: "running",
  summary: "Reading the auth flow",
  title: "Fix the login redirect",
  updatedAt: "2026-11-03T12:00:00Z",
};
const AUTH_TEST_FILE = /src\/auth\.test\.ts/u;
const STORED_CAPTURE = /Showing the stored capture/u;
const LOGO_FILE = /assets\/logo\.png/iu;
const AUTH_FILE = /src\/auth\.ts/iu;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test("parses hunk headers into old and new line numbers", () => {
  expect(parseDiffLines("@@ -4,2 +8,3 @@\n context\n-old\n+new")).toEqual([
    { kind: "meta", newNumber: null, oldNumber: null, text: "@@ -4,2 +8,3 @@" },
    { kind: "context", newNumber: 8, oldNumber: 4, text: "context" },
    { kind: "remove", newNumber: null, oldNumber: 5, text: "old" },
    { kind: "add", newNumber: 9, oldNumber: null, text: "new" },
  ]);
});

test("shows a legacy single-file capture with a selectable diff and line numbers", async () => {
  installFakes();
  render(<CodeTaskChanges task={task} />);

  expect(await screen.findByRole("button", { name: AUTH_FILE })).toBeTruthy();
  expect(screen.getByText("new")).toBeTruthy();
  expect(screen.getByText("old")).toBeTruthy();
  expect(screen.getByTestId("diff-viewer")).toBeTruthy();
  expect(screen.getByText("Workspace capture")).toBeTruthy();
});

test("switches between files and identifies a file without a text patch", async () => {
  const { server } = installFakes();
  server.on(
    "GET",
    "/api/code-tasks/task-1/diff",
    json({
      files: [
        {
          additions: 1,
          deletions: 1,
          patch:
            "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new",
          path: "src/auth.ts",
          status: "modified",
        },
        {
          additions: 0,
          deletions: 0,
          patch: null,
          path: "assets/logo.png",
          status: "modified",
        },
      ],
      source: "github",
      truncated: false,
    })
  );

  render(<CodeTaskChanges task={task} />);
  await waitFor(() => expect(screen.getByText("Published PR")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: LOGO_FILE }));

  expect(
    await screen.findByText(
      "This file has no text patch. It may be binary or unavailable."
    )
  ).toBeTruthy();
  expect(screen.queryByTestId("diff-viewer")).toBeNull();
});

test("keeps per-file patches and truncation visible when the diff service is unavailable", async () => {
  installFakes();
  render(
    <CodeTaskChanges
      task={{
        ...task,
        execution: {
          diff: "diff --git a/src/auth.ts b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/src/auth.test.ts b/src/auth.test.ts\nnew file mode 100644\n@@ -0,0 +1 @@\n+test the redirect\n",
          diffTruncated: true,
          files: ["src/auth.ts", "src/auth.test.ts"],
        },
      }}
    />
  );
  fireEvent.click(await screen.findByRole("button", { name: AUTH_TEST_FILE }));
  expect(screen.getByText("test the redirect")).toBeTruthy();
  expect(screen.getByText("Diff truncated")).toBeTruthy();
  expect(screen.queryByText("old")).toBeNull();
  await screen.findByText(STORED_CAPTURE);
});

test("does not create a phantom line from the newline after an added file", () => {
  expect(parseDiffLines("@@ -0,0 +1 @@\n+new file\n")).toEqual([
    { kind: "meta", newNumber: null, oldNumber: null, text: "@@ -0,0 +1 @@" },
    { kind: "add", newNumber: 1, oldNumber: null, text: "new file" },
  ]);
});

test("does not show another file's patch for a checkpoint file that was reverted", async () => {
  installFakes();
  render(<CodeTaskChanges initialPath="reverted.ts" task={task} />);
  expect(
    await screen.findByText("No current diff for this file.")
  ).toBeTruthy();
  expect(screen.getByText("reverted.ts")).toBeTruthy();
  expect(screen.queryByTestId("diff-viewer")).toBeNull();
});

test("highlights increment/decrement and SQL comment lines as changes, with correct numbering", () => {
  expect(
    parseDiffLines(
      "--- a/query.sql\n+++ b/query.sql\n@@ -8,3 +12,3 @@\n---counter;\n+++counter;\n--- comment\n+++ comment\n keep\n\\ No newline at end of file\n"
    )
  ).toEqual([
    { kind: "meta", newNumber: null, oldNumber: null, text: "--- a/query.sql" },
    { kind: "meta", newNumber: null, oldNumber: null, text: "+++ b/query.sql" },
    {
      kind: "meta",
      newNumber: null,
      oldNumber: null,
      text: "@@ -8,3 +12,3 @@",
    },
    { kind: "remove", newNumber: null, oldNumber: 8, text: "--counter;" },
    { kind: "add", newNumber: 12, oldNumber: null, text: "++counter;" },
    { kind: "remove", newNumber: null, oldNumber: 9, text: "-- comment" },
    { kind: "add", newNumber: 13, oldNumber: null, text: "++ comment" },
    { kind: "context", newNumber: 14, oldNumber: 10, text: "keep" },
    {
      kind: "meta",
      newNumber: null,
      oldNumber: null,
      text: "\\ No newline at end of file",
    },
  ]);
});
