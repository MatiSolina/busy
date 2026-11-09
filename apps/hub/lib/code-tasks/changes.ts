import type { CodeTaskDiff, CodeTaskDiffFile } from "./diff-types";
import { parseGitDiffHeader } from "./git-diff-path";
import type { PublicCodeTask } from "./types";

// agent-tools stores captures at 100,000 UTF-16 characters. Keep this limit
// aligned so the viewer marks those older captures as truncated.
const MAX_DIFF_CHARS = 100_000;
const MAX_FILES = 20_000;
const MAX_PATH_LENGTH = 1000;
const AUTHORIZATION = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gu;
const DIFF_SECTION = /^diff --git /mu;
const HUNK_BOUNDARY = /^@@ /mu;
const NEW_FILE_MODE = /^new file mode\s+/mu;
const DELETED_FILE_MODE = /^deleted file mode\s+/mu;
const ADDED_NULL = /^--- \/dev\/null$/mu;
const DELETED_NULL = /^\+\+\+ \/dev\/null$/mu;

export type CodeTaskChangeStatus = "added" | "deleted" | "modified";

export type CodeTaskChange = CodeTaskDiffFile & {
  status: CodeTaskChangeStatus;
};

function safeText(value: string): string {
  return value
    .replace(AUTHORIZATION, "[redacted authorization]")
    .replace(TOKEN, "[redacted credential]");
}

function safePath(value: string): string | null {
  const path = value.trim();
  if (
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (part) =>
          part === "" || part === "." || part === ".." || part === ".git"
      ) ||
    [...path].some(
      (character) => character <= "\u001f" || character === "\u007f"
    )
  ) {
    return null;
  }
  return path;
}

function pathFromHeader(value: string): string | null {
  const match = parseGitDiffHeader(value);
  if (!match) {
    return null;
  }
  // Git writes the same path on both sides for ordinary changes. Prefer the
  // destination path for renames, while still keeping the parser bounded.
  return safePath(match.path);
}

function sectionStatus(section: string): CodeTaskChangeStatus {
  const [metadata = ""] = section.split(HUNK_BOUNDARY, 1);
  if (NEW_FILE_MODE.test(metadata) || ADDED_NULL.test(metadata)) {
    return "added";
  }
  if (DELETED_FILE_MODE.test(metadata) || DELETED_NULL.test(metadata)) {
    return "deleted";
  }
  return "modified";
}

function countLines(section: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of section.split("\n")) {
    if (HUNK_BOUNDARY.test(line)) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return { additions, deletions };
}

function parseSections(diff: string): Map<string, CodeTaskChange> {
  const sections = diff.split(DIFF_SECTION).slice(1);
  const parsed = new Map<string, CodeTaskChange>();
  for (const raw of sections) {
    const section = `diff --git ${raw}`;
    const header = section.split("\n", 1)[0] ?? "";
    const path = pathFromHeader(header);
    if (!path || parsed.size >= MAX_FILES) {
      continue;
    }
    const counts = countLines(section);
    parsed.set(path, {
      ...counts,
      patch: safeText(section),
      path,
      status: sectionStatus(section),
    });
  }
  return parsed;
}

function taskFiles(task: PublicCodeTask): string[] {
  const { files } = task.execution;
  if (!Array.isArray(files)) {
    return [];
  }
  return files.flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }
    const path = safePath(value);
    return path ? [path] : [];
  });
}

/**
 * Turn the bounded capture recorded by the coding agent into a file-oriented
 * diff model for the task viewer. It deliberately reads only the public task
 * projection, so workspace credentials and GitHub OAuth tokens never enter
 * this response.
 */
export function publicTaskDiff(task: PublicCodeTask): CodeTaskDiff {
  const rawDiff =
    typeof task.execution.diff === "string" ? task.execution.diff : null;
  const safeDiff = rawDiff ? safeText(rawDiff) : null;
  const truncated =
    task.execution.diffTruncated === true ||
    Boolean(safeDiff && safeDiff.length >= MAX_DIFF_CHARS);
  const diff = safeDiff ? safeDiff.slice(0, MAX_DIFF_CHARS) : null;
  const parsed = diff ? parseSections(diff) : new Map<string, CodeTaskChange>();
  const files = taskFiles(task).map((path) => {
    const existing = parsed.get(path);
    if (existing) {
      return existing;
    }
    return {
      additions: 0,
      deletions: 0,
      patch: null,
      path,
      status: "modified" as const,
    };
  });
  for (const [path, change] of parsed) {
    if (!files.some((item) => item.path === path)) {
      files.push(change);
    }
  }
  // Older task captures can contain a patch without a `diff --git` header.
  // Keep that useful evidence visible when there is exactly one known file.
  if (diff && parsed.size === 0 && files.length === 1) {
    const [file] = files;
    if (file) {
      const counts = countLines(diff);
      files[0] = { ...file, ...counts, patch: diff };
    }
  }
  return {
    files: files.slice(0, MAX_FILES),
    source: "workspace",
    truncated,
  };
}
