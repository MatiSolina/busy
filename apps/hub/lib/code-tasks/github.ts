import type { OAuthData } from "../mcp/oauth";
import { McpOAuthProvider } from "../mcp/oauth";
import { freshRegisteredToken } from "../mcp/registered-oauth";
import { withConnection } from "../mcp/store";

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "Busy-code-task";
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_CHANGED_FILES = 20_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CHANGE_PAYLOAD_BYTES = 24 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/iu;
const FULL_NAME =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u;
const BRANCH = /^[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const ARCHIVE_REDIRECT_TOKEN = /^[A-Za-z0-9._~+/=-]{1,4096}$/u;
const AUTHORIZATION = /(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const TOKEN =
  /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/gu;
const GITHUB_ID = (value: Record<string, unknown>): string | null => {
  if (typeof value.id === "number") {
    return String(value.id);
  }
  return typeof value.node_id === "string" ? value.node_id : null;
};

function safePublicationText(
  value: string | undefined,
  maxLength: number
): string | undefined {
  return value
    ?.replace(AUTHORIZATION, "[redacted authorization]")
    .replace(TOKEN, "[redacted credential]")
    .slice(0, maxLength);
}

export interface GitHubRepositoryMeta {
  baseRef: string;
  defaultBranch: string;
  fullName: string;
  githubId: string;
  name: string;
  owner: string;
  private: boolean;
  remoteBaseSha: string;
  treeSha: string;
}

export interface GitHubRepository {
  canPush?: boolean;
  defaultBranch: string;
  fullName: string;
  githubId: string;
  private: boolean;
}

export interface GitHubChange {
  contentBase64?: string;
  mode?: "100644" | "100755" | "120000";
  path: string;
  status: "added" | "modified" | "deleted";
}

export interface PublishedGitHubChange {
  branch: string;
  commitSha: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface PublishChangesOptions {
  checks?: string;
  summary?: string;
  title?: string;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    status: number,
    code: string,
    message = "GitHub request failed",
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "GitHubApiError";
    this.status = status;
    this.code = code;
  }
}

type Fetcher = typeof fetch;

function hubOrigin(): string {
  const raw = process.env.HUB_URL ?? "http://localhost:3000";
  try {
    return new URL(raw).origin;
  } catch (error) {
    throw new Error("HUB_URL is invalid", { cause: error });
  }
}

function repositoryParts(fullName: string): { owner: string; name: string } {
  if (!FULL_NAME.test(fullName)) {
    throw new Error("GitHub repository must use owner/repository format");
  }
  const [owner, name] = fullName.split("/");
  if (!(owner && name)) {
    throw new Error("GitHub repository must use owner/repository format");
  }
  return { name, owner };
}

function repositoryPath(fullName: string): string {
  const { owner, name } = repositoryParts(fullName);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

function assertBranch(branch: string): void {
  if (
    !BRANCH.test(branch) ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.startsWith("refs/")
  ) {
    throw new Error("GitHub branch name is invalid");
  }
}

function encodedBranch(branch: string): string {
  assertBranch(branch);
  return branch.split("/").map(encodeURIComponent).join("/");
}

function validArchiveRedirectQuery(url: URL, tokenRequired: boolean): boolean {
  const entries = [...url.searchParams.entries()];
  // Public archives do not need a signed query. Private GitHub archives add
  // exactly one short-lived token parameter.
  if (entries.length === 0) {
    return !tokenRequired;
  }
  if (!tokenRequired || entries.length !== 1 || entries[0]?.[0] !== "token") {
    return false;
  }
  return ARCHIVE_REDIRECT_TOKEN.test(entries[0][1]);
}

async function githubToken(connectionId: string): Promise<string> {
  const result = await withConnection(connectionId, async (row, raw) => {
    if (row.catalogId !== "github" || row.status !== "connected") {
      throw new Error("GitHub connection is not connected");
    }
    const data = raw as OAuthData & {
      registeredProvider?: "github" | "google";
    };
    if (data.registeredProvider !== "github") {
      throw new Error("GitHub connection must be reconnected");
    }
    const provider = new McpOAuthProvider(data, {
      connectionId: row.id,
      origin: data.redirectOrigin ?? hubOrigin(),
    });
    const refreshed = await freshRegisteredToken(provider, "github");
    return {
      data: provider.data,
      error: null,
      status: "connected" as const,
      value: refreshed.token,
    };
  });
  if (!result) {
    throw new Error("GitHub connection not found");
  }
  return result;
}

/** Server-only token broker for trusted GitHub operations; never pass this into a task workspace. */
export function getGitHubAccessToken(connectionId: string): Promise<string> {
  return githubToken(connectionId);
}

async function githubRequest<T>(
  connectionId: string,
  path: string,
  init: RequestInit = {},
  fetchImpl: Fetcher = fetch
): Promise<T> {
  const token = await githubToken(connectionId);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-GitHub-Api-Version", API_VERSION);
  headers.set("User-Agent", USER_AGENT);
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetchImpl(`${API_ORIGIN}${path}`, {
    ...init,
    headers,
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new GitHubApiError(
      response.status,
      response.status === 401 || response.status === 403
        ? "access_denied"
        : "github_request_failed"
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  const value: unknown = await response.json().catch(() => null);
  if (value === null) {
    throw new GitHubApiError(response.status, "invalid_github_response");
  }
  return value as T;
}

export async function listGitHubRepositories(
  connectionId: string,
  fetchImpl?: Fetcher,
  page = 1
): Promise<GitHubRepository[]> {
  const rows = await githubRequest<Record<string, unknown>[]>(
    connectionId,
    `/user/repos?per_page=100&page=${Math.max(1, Math.floor(page))}&sort=updated`,
    {},
    fetchImpl
  );
  return rows.flatMap((row) => {
    const githubId = GITHUB_ID(row);
    const fullName = typeof row.full_name === "string" ? row.full_name : null;
    const defaultBranch =
      typeof row.default_branch === "string" ? row.default_branch : null;
    const permissions =
      row.permissions && typeof row.permissions === "object"
        ? (row.permissions as Record<string, unknown>)
        : undefined;
    const canPush =
      typeof permissions?.push === "boolean" ? permissions.push : undefined;
    if (!(githubId && fullName && defaultBranch && FULL_NAME.test(fullName))) {
      return [];
    }
    return [
      {
        ...(canPush === undefined ? {} : { canPush }),
        defaultBranch,
        fullName,
        githubId,
        private: row.private === true,
      },
    ];
  });
}

export async function resolveRepository(
  connectionId: string,
  fullName: string,
  baseRef?: string,
  fetchImpl?: Fetcher
): Promise<GitHubRepositoryMeta> {
  const repo = await githubRequest<Record<string, unknown>>(
    connectionId,
    repositoryPath(fullName),
    {},
    fetchImpl
  );
  const permissions =
    repo.permissions && typeof repo.permissions === "object"
      ? (repo.permissions as Record<string, unknown>)
      : null;
  if (permissions?.push !== true) {
    throw new GitHubApiError(
      403,
      "write_access_required",
      "GitHub connection cannot write this repository"
    );
  }
  const canonical =
    typeof repo.full_name === "string" ? repo.full_name : fullName;
  const names = repositoryParts(canonical);
  const defaultBranch =
    typeof repo.default_branch === "string" ? repo.default_branch : null;
  const chosenRef = baseRef?.trim() || defaultBranch;
  if (!(defaultBranch && chosenRef)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  const commit = await githubRequest<Record<string, unknown>>(
    connectionId,
    `${repositoryPath(canonical)}/commits/${encodeURIComponent(chosenRef)}`,
    {},
    fetchImpl
  );
  const remoteBaseSha =
    typeof commit.sha === "string" && SHA.test(commit.sha) ? commit.sha : null;
  const commitData =
    commit.commit && typeof commit.commit === "object"
      ? (commit.commit as Record<string, unknown>)
      : null;
  const tree =
    commitData?.tree && typeof commitData.tree === "object"
      ? (commitData.tree as Record<string, unknown>)
      : null;
  const treeSha =
    typeof tree?.sha === "string" && SHA.test(tree.sha) ? tree.sha : null;
  const githubId = GITHUB_ID(repo);
  if (!(githubId && remoteBaseSha && treeSha)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  return {
    baseRef: chosenRef,
    defaultBranch,
    fullName: canonical,
    githubId,
    name: names.name,
    owner: names.owner,
    private: repo.private === true,
    remoteBaseSha,
    treeSha,
  };
}

export async function downloadRepositoryArchive(
  meta: GitHubRepositoryMeta,
  connectionId: string,
  fetchImpl: Fetcher = fetch
): Promise<Uint8Array> {
  if (!SHA.test(meta.remoteBaseSha)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  const token = await githubToken(connectionId);
  const archiveEndpoint = `${API_ORIGIN}${repositoryPath(meta.fullName)}/tarball/${encodeURIComponent(meta.remoteBaseSha)}`;
  const response = await fetchImpl(archiveEndpoint, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": API_VERSION,
    },
    redirect: "manual",
  });
  let archiveResponse = response;
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (!location) {
      throw new GitHubApiError(response.status, "archive_redirect_invalid");
    }
    let redirected: URL;
    try {
      redirected = new URL(location, archiveEndpoint);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: GitHubApiError stores the cause in its options argument.
      throw new GitHubApiError(
        response.status,
        "archive_redirect_invalid",
        "GitHub archive redirect is invalid",
        { cause: error }
      );
    }
    const names = repositoryParts(meta.fullName);
    const expectedPaths = new Set([
      `/${names.owner}/${names.name}/tar.gz/${meta.remoteBaseSha}`,
      `/${names.owner}/${names.name}/legacy.tar.gz/${meta.remoteBaseSha}`,
    ]);
    if (
      redirected.protocol !== "https:" ||
      redirected.hostname !== "codeload.github.com" ||
      redirected.port !== "" ||
      !expectedPaths.has(redirected.pathname) ||
      !validArchiveRedirectQuery(redirected, meta.private) ||
      redirected.hash ||
      redirected.username ||
      redirected.password
    ) {
      throw new GitHubApiError(response.status, "archive_redirect_invalid");
    }
    // Do not forward the OAuth bearer to codeload.github.com. The signed
    // archive URL is sufficient for this one transfer.
    archiveResponse = await fetchImpl(redirected, {
      headers: { Accept: "application/octet-stream", "User-Agent": USER_AGENT },
      redirect: "error",
    });
  }
  if (!(archiveResponse.ok && archiveResponse.body)) {
    throw new GitHubApiError(archiveResponse.status, "archive_download_failed");
  }
  const length = Number(archiveResponse.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_ARCHIVE_BYTES) {
    throw new Error("Repository archive exceeds the 25 MiB limit");
  }
  const bytes = new Uint8Array(await archiveResponse.arrayBuffer());
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("Repository archive exceeds the 25 MiB limit");
  }
  return bytes;
}

export const githubLimits = { maxArchiveBytes: MAX_ARCHIVE_BYTES } as const;

async function findPullRequest(
  connectionId: string,
  meta: GitHubRepositoryMeta,
  branch: string,
  fetchImpl?: Fetcher
): Promise<{ number: number; html_url: string } | null> {
  const rows = await githubRequest<Record<string, unknown>[]>(
    connectionId,
    `${repositoryPath(meta.fullName)}/pulls?state=open&head=${encodeURIComponent(`${meta.owner}:${branch}`)}&per_page=20`,
    {},
    fetchImpl
  );
  const row = rows.find(
    (candidate) =>
      typeof candidate.number === "number" &&
      typeof candidate.html_url === "string"
  );
  return row
    ? { html_url: row.html_url as string, number: row.number as number }
    : null;
}

interface GitHubCommitLineage {
  parentSha: string | null;
  treeSha: string | null;
}

async function readGitCommitLineage(
  connectionId: string,
  fullName: string,
  commitSha: string,
  fetchImpl?: Fetcher
): Promise<GitHubCommitLineage> {
  const commit = await githubRequest<Record<string, unknown>>(
    connectionId,
    `${repositoryPath(fullName)}/git/commits/${commitSha}`,
    {},
    fetchImpl
  );
  const treeSha =
    commit.tree && typeof commit.tree === "object"
      ? (commit.tree as Record<string, unknown>).sha
      : null;
  const parents = Array.isArray(commit.parents) ? commit.parents : [];
  const parentSha =
    parents[0] && typeof parents[0] === "object"
      ? (parents[0] as Record<string, unknown>).sha
      : null;
  return {
    parentSha: typeof parentSha === "string" ? parentSha : null,
    treeSha: typeof treeSha === "string" ? treeSha : null,
  };
}

/**
 * Creates an owned branch, commit and draft PR through Git Data API only.
 * Git credentials never enter the task workspace.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: publication is an intentionally linear GitHub transaction with reconciliation.
export async function publishChanges(
  connectionId: string,
  meta: GitHubRepositoryMeta,
  expectedRemoteHead: string,
  branch: string,
  changes: readonly GitHubChange[],
  fetchImpl?: Fetcher,
  options: PublishChangesOptions = {}
): Promise<PublishedGitHubChange> {
  if (!SHA.test(expectedRemoteHead)) {
    throw new Error("Expected remote head is invalid");
  }
  if (!(branch.startsWith("codex/busy-") && BRANCH.test(branch))) {
    throw new Error("Publication branch is not owned by Busy");
  }
  if (branch === meta.defaultBranch || branch === meta.baseRef) {
    throw new Error("Busy cannot publish to the default branch");
  }
  if (changes.length > MAX_CHANGED_FILES) {
    throw new Error("Too many changed files");
  }
  const refPath = `${repositoryPath(meta.fullName)}/git/ref/heads/${encodedBranch(branch)}`;
  let existing: Record<string, unknown> | null = null;
  try {
    existing = await githubRequest<Record<string, unknown>>(
      connectionId,
      refPath,
      {},
      fetchImpl
    );
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }
  }
  let existingSha: string | null = null;
  if (existing) {
    const candidate =
      existing.object && typeof existing.object === "object"
        ? (existing.object as Record<string, unknown>).sha
        : null;
    if (typeof candidate !== "string" || !SHA.test(candidate)) {
      throw new GitHubApiError(200, "invalid_github_response");
    }
    existingSha = candidate;
  }
  const { treeSha } = meta;
  if (!SHA.test(treeSha)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  const entries: Record<string, unknown>[] = [];
  const seenPaths = new Set<string>();
  let encodedPayloadBytes = 0;
  for (const change of changes) {
    if (
      !(
        change.status === "added" ||
        change.status === "modified" ||
        change.status === "deleted"
      )
    ) {
      throw new Error("GitHub change status is invalid");
    }
    if (
      !change.path ||
      change.path.startsWith("/") ||
      change.path
        .split("/")
        .some(
          (segment) =>
            segment === ".." ||
            segment === "" ||
            segment === "." ||
            segment === ".git"
        )
    ) {
      throw new Error("GitHub change path is invalid");
    }
    if (seenPaths.has(change.path)) {
      throw new Error("GitHub change paths must be unique");
    }
    seenPaths.add(change.path);
    if (change.status === "deleted") {
      entries.push({
        mode: "100644",
        path: change.path,
        sha: null,
        type: "blob",
      });
      continue;
    }
    const encoded = change.contentBase64;
    if (
      !(
        typeof encoded === "string" &&
        BASE64.test(encoded) &&
        encoded.length % 4 === 0 &&
        Buffer.from(encoded, "base64").byteLength <= MAX_FILE_BYTES
      )
    ) {
      throw new Error("GitHub change content is invalid");
    }
    encodedPayloadBytes += encoded.length;
    if (encodedPayloadBytes > MAX_CHANGE_PAYLOAD_BYTES) {
      throw new Error("Changed file payload exceeds the 24 MiB limit");
    }
    if (change.mode && !["100644", "100755"].includes(change.mode)) {
      throw new Error("GitHub change mode is invalid");
    }
    // biome-ignore lint/performance/noAwaitInLoops: Git blobs are created in deterministic order for the tree manifest.
    const blob = await githubRequest<Record<string, unknown>>(
      connectionId,
      `${repositoryPath(meta.fullName)}/git/blobs`,
      {
        body: JSON.stringify({
          content: encoded,
          encoding: "base64",
        }),
        method: "POST",
      },
      fetchImpl
    );
    if (typeof blob.sha !== "string" || !SHA.test(blob.sha)) {
      throw new GitHubApiError(200, "invalid_github_response");
    }
    entries.push({
      mode: change.mode ?? "100644",
      path: change.path,
      sha: blob.sha,
      type: "blob",
    });
  }
  const newTree = await githubRequest<Record<string, unknown>>(
    connectionId,
    `${repositoryPath(meta.fullName)}/git/trees`,
    {
      body: JSON.stringify({ base_tree: treeSha, tree: entries }),
      method: "POST",
    },
    fetchImpl
  );
  if (typeof newTree.sha !== "string" || !SHA.test(newTree.sha)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  let publishedSha: string | null = null;
  if (existingSha && existingSha !== expectedRemoteHead) {
    const existingCommit = await githubRequest<Record<string, unknown>>(
      connectionId,
      `${repositoryPath(meta.fullName)}/git/commits/${existingSha}`,
      {},
      fetchImpl
    );
    const existingTree =
      existingCommit.tree && typeof existingCommit.tree === "object"
        ? (existingCommit.tree as Record<string, unknown>).sha
        : null;
    const parents = Array.isArray(existingCommit.parents)
      ? existingCommit.parents
      : [];
    const existingParent =
      parents[0] && typeof parents[0] === "object"
        ? (parents[0] as Record<string, unknown>).sha
        : null;
    if (existingTree === newTree.sha && existingParent === expectedRemoteHead) {
      // The previous request created the exact desired commit, but its response
      // was lost. Reuse it and do not create a duplicate commit or PR.
      publishedSha = existingSha;
    } else {
      throw new GitHubApiError(409, "branch_conflict");
    }
  }
  if (!publishedSha) {
    const createdCommit = await githubRequest<Record<string, unknown>>(
      connectionId,
      `${repositoryPath(meta.fullName)}/git/commits`,
      {
        body: JSON.stringify({
          message: `Busy: ${branch}`,
          parents: [expectedRemoteHead],
          tree: newTree.sha,
        }),
        method: "POST",
      },
      fetchImpl
    );
    if (typeof createdCommit.sha !== "string" || !SHA.test(createdCommit.sha)) {
      throw new GitHubApiError(200, "invalid_github_response");
    }
    publishedSha = createdCommit.sha;
  }
  if (existingSha === expectedRemoteHead) {
    await githubRequest(
      connectionId,
      `${repositoryPath(meta.fullName)}/git/refs/heads/${encodedBranch(branch)}`,
      {
        body: JSON.stringify({ force: false, sha: publishedSha }),
        method: "PATCH",
      },
      fetchImpl
    );
  } else if (!existingSha) {
    try {
      await githubRequest(
        connectionId,
        `${repositoryPath(meta.fullName)}/git/refs`,
        {
          body: JSON.stringify({
            ref: `refs/heads/${branch}`,
            sha: publishedSha,
          }),
          method: "POST",
        },
        fetchImpl
      );
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) {
        throw error;
      }
      const raced = await githubRequest<Record<string, unknown>>(
        connectionId,
        refPath,
        {},
        fetchImpl
      );
      const racedSha =
        raced.object && typeof raced.object === "object"
          ? (raced.object as Record<string, unknown>).sha
          : null;
      if (racedSha !== publishedSha) {
        // biome-ignore lint/style/useErrorCause: GitHubApiError stores the cause in its options argument.
        throw new GitHubApiError(
          409,
          "branch_conflict",
          "GitHub branch changed during publication",
          { cause: error }
        );
      }
    }
  }
  let pr = await findPullRequest(connectionId, meta, branch, fetchImpl);
  if (!pr) {
    try {
      const summary = safePublicationText(options.summary, 8000);
      const checks = safePublicationText(options.checks, 8000);
      const created = await githubRequest<Record<string, unknown>>(
        connectionId,
        `${repositoryPath(meta.fullName)}/pulls`,
        {
          body: JSON.stringify({
            base: meta.baseRef,
            body: [
              "Created by Busy code task.",
              summary,
              checks ? `Checks:\n${checks}` : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
            draft: true,
            head: branch,
            title: safePublicationText(options.title, 200) ?? `Busy: ${branch}`,
          }),
          method: "POST",
        },
        fetchImpl
      );
      if (
        typeof created.number !== "number" ||
        typeof created.html_url !== "string"
      ) {
        throw new GitHubApiError(200, "invalid_github_response");
      }
      pr = { html_url: created.html_url, number: created.number };
    } catch (error) {
      const recovered = await findPullRequest(
        connectionId,
        meta,
        branch,
        fetchImpl
      );
      if (!recovered) {
        throw error;
      }
      pr = recovered;
    }
  }
  return {
    branch,
    commitSha: publishedSha,
    pullRequestNumber: pr.number,
    pullRequestUrl: pr.html_url,
  };
}

/** Updates only the task-owned draft PR's human-facing summary/checks. */
export async function updateDraftDetails(
  connectionId: string,
  meta: GitHubRepositoryMeta,
  branch: string,
  options: PublishChangesOptions,
  fetchImpl?: Fetcher
): Promise<{ pullRequestNumber: number; pullRequestUrl: string }> {
  if (!(branch.startsWith("codex/busy-") && BRANCH.test(branch))) {
    throw new Error("Publication branch is not owned by Busy");
  }
  const pr = await findPullRequest(connectionId, meta, branch, fetchImpl);
  if (!pr) {
    throw new GitHubApiError(404, "pull_request_not_found");
  }
  const summary = safePublicationText(options.summary, 8000);
  const checks = safePublicationText(options.checks, 8000);
  const body = [
    "Created by Busy code task.",
    summary,
    checks ? `Checks:\n${checks}` : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
  const updated = await githubRequest<Record<string, unknown>>(
    connectionId,
    `${repositoryPath(meta.fullName)}/pulls/${pr.number}`,
    {
      body: JSON.stringify({
        ...(options.title
          ? { title: safePublicationText(options.title, 200) }
          : {}),
        body,
      }),
      method: "PATCH",
    },
    fetchImpl
  );
  if (
    typeof updated.number !== "number" ||
    typeof updated.html_url !== "string"
  ) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  return {
    pullRequestNumber: updated.number,
    pullRequestUrl: updated.html_url,
  };
}

/**
 * Reconcile a task whose local checkout has returned to its original baseline.
 *
 * `publishChanges` intentionally rejects an empty change set, but a correction
 * can make a previously published task empty. The task owns its `codex/busy-*`
 * branch, so resetting that branch to the pinned base commit is the safe way to
 * represent the reversal remotely. We only force-update the branch when its
 * current head is the last commit recorded by Busy (or it is already at the
 * base), which prevents clobbering an unrelated manual edit.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconciliation is an intentionally linear GitHub transaction with race checks.
export async function reconcilePublication(
  connectionId: string,
  meta: GitHubRepositoryMeta,
  expectedRemoteHead: string,
  publishedCommitSha: string,
  branch: string,
  options: PublishChangesOptions = {},
  fetchImpl?: Fetcher
): Promise<{
  branch: string;
  commitSha: string;
  pullRequestNumber: number | null;
  pullRequestUrl: string | null;
}> {
  if (!(SHA.test(expectedRemoteHead) && SHA.test(publishedCommitSha))) {
    throw new Error("Publication commit is invalid");
  }
  if (!(branch.startsWith("codex/busy-") && BRANCH.test(branch))) {
    throw new Error("Publication branch is not owned by Busy");
  }
  if (branch === meta.defaultBranch || branch === meta.baseRef) {
    throw new Error("Busy cannot reconcile the default branch");
  }
  if (!SHA.test(meta.treeSha)) {
    throw new GitHubApiError(200, "invalid_github_response");
  }

  const refPath = `${repositoryPath(meta.fullName)}/git/ref/heads/${encodedBranch(branch)}`;
  const refsPath = `${repositoryPath(meta.fullName)}/git/refs/heads/${encodedBranch(branch)}`;
  let current: Record<string, unknown>;
  try {
    current = await githubRequest<Record<string, unknown>>(
      connectionId,
      refPath,
      {},
      fetchImpl
    );
  } catch (error) {
    if (error instanceof GitHubApiError && error.status === 404) {
      // biome-ignore lint/style/useErrorCause: GitHubApiError stores the cause in its options argument.
      throw new GitHubApiError(
        404,
        "publication_branch_not_found",
        "GitHub publication branch was not found",
        { cause: error }
      );
    }
    throw error;
  }
  const currentSha =
    current.object && typeof current.object === "object"
      ? (current.object as Record<string, unknown>).sha
      : null;
  if (!(typeof currentSha === "string" && SHA.test(currentSha))) {
    throw new GitHubApiError(200, "invalid_github_response");
  }
  let reconciledSha = expectedRemoteHead;
  if (currentSha !== expectedRemoteHead) {
    if (currentSha === publishedCommitSha) {
      const currentCommit = await readGitCommitLineage(
        connectionId,
        meta.fullName,
        currentSha,
        fetchImpl
      );
      if (currentCommit.treeSha === meta.treeSha) {
        // The task may already point at a restore commit from an earlier
        // successful call. Do not create a second identical commit.
        reconciledSha = currentSha;
      } else {
        const restored = await githubRequest<Record<string, unknown>>(
          connectionId,
          `${repositoryPath(meta.fullName)}/git/commits`,
          {
            body: JSON.stringify({
              message: `Busy: restore ${branch}`,
              parents: [currentSha],
              tree: meta.treeSha,
            }),
            method: "POST",
          },
          fetchImpl
        );
        if (!(typeof restored.sha === "string" && SHA.test(restored.sha))) {
          throw new GitHubApiError(200, "invalid_github_response");
        }
        reconciledSha = restored.sha;
        // A non-force update makes the GET → commit → ref sequence safe against
        // a manual edit that races the reconciliation.
        await githubRequest(
          connectionId,
          refsPath,
          {
            body: JSON.stringify({ force: false, sha: reconciledSha }),
            method: "PATCH",
          },
          fetchImpl
        );
      }
    } else {
      // The commit may have been created and the response lost before the ref
      // update was observed. Recognize that exact restore commit so retries do
      // not create another commit or report a conflict.
      const existingCommit = await readGitCommitLineage(
        connectionId,
        meta.fullName,
        currentSha,
        fetchImpl
      );
      if (
        existingCommit.treeSha !== meta.treeSha ||
        existingCommit.parentSha !== publishedCommitSha
      ) {
        throw new GitHubApiError(
          409,
          "branch_conflict",
          "GitHub publication branch changed outside Busy"
        );
      }
      reconciledSha = currentSha;
    }
  }

  const pr = await findPullRequest(connectionId, meta, branch, fetchImpl);
  if (!pr) {
    return {
      branch,
      commitSha: reconciledSha,
      pullRequestNumber: null,
      pullRequestUrl: null,
    };
  }
  const updated = await updateDraftDetails(
    connectionId,
    meta,
    branch,
    options,
    fetchImpl
  );
  return {
    branch,
    commitSha: reconciledSha,
    pullRequestNumber: updated.pullRequestNumber,
    pullRequestUrl: updated.pullRequestUrl,
  };
}
