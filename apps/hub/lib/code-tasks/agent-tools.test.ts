import type { FxAgentHostTool, FxToolContext } from "libfx";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeTaskRow } from "../db";
import { codingTools, fencedShell } from "./agent-tools";

const h = vi.hoisted(() => ({
  append: vi.fn(),
  capture: vi.fn(),
  publish: vi.fn(),
  reconcile: vi.fn(),
  shell: vi.fn(),
  task: {} as Record<string, unknown>,
}));
vi.mock("./store", () => ({
  admitToolCall: async () =>
    h.task.status === "running" ? h.task : (null as unknown),
  appendEvent: (...args: unknown[]) => h.append(...args),
  getRepositoryRow: async () => ({ connectionId: "connection", enabled: true }),
  getTaskBySession: async () => h.task,
  getTaskRow: async () => h.task,
  transitionTask: (
    _id: string,
    transition: {
      from: string[];
      to?: string;
      execution?: Record<string, unknown>;
      patch?: Record<string, unknown>;
    }
  ) => {
    if (!transition.from.includes(String(h.task.status))) {
      return Promise.resolve(null);
    }
    Object.assign(h.task, transition.patch ?? {});
    if (transition.execution) {
      h.task.execution = {
        ...(h.task.execution as Record<string, unknown>),
        ...transition.execution,
      };
    }
    if (transition.to) {
      h.task.status = transition.to;
    }
    return Promise.resolve(h.task);
  },
  updateTask: (_id: string, patch: Record<string, unknown>) => {
    Object.assign(h.task, patch);
    return Promise.resolve(h.task);
  },
  withPublicationLease: (
    _id: string,
    _revision: number,
    version: number,
    run: (task: unknown, token: string) => unknown
  ) => {
    if (
      h.task.instructionVersion !== version ||
      h.task.appliedInstructionVersion !== version
    ) {
      throw new Error("stale");
    }
    return run(h.task, "lease");
  },
}));
vi.mock("./github", () => ({
  downloadRepositoryArchive: vi.fn(),
  publishChanges: (...args: unknown[]) => h.publish(...args),
  reconcilePublication: (...args: unknown[]) => h.reconcile(...args),
  resolveRepository: vi.fn(),
  updateDraftDetails: vi.fn().mockResolvedValue({}),
}));
vi.mock("./workspace", () => ({
  captureWorkspace: (...args: unknown[]) => h.capture(...args),
  prepareWorkspace: vi.fn(),
}));

const context: FxToolContext = {
  executionId: "tool-call-1",
  sessionId: "session-1",
  signal: new AbortController().signal,
};
function tool(name: string) {
  const base: FxAgentHostTool = {
    description: "shell",
    execute: h.shell,
    idempotent: false,
    inputSchema: {},
    name: "shell",
  };
  const found = codingTools([base], async () => undefined).find(
    (entry) => entry.name === name
  );
  if (!found) {
    throw new Error(`Missing tool: ${name}`);
  }
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.task = {
    appliedInstructionVersion: 1,
    baseBranch: "main",
    branch: "codex/busy-task",
    createdAt: new Date(),
    durableSessionId: "session-1",
    execution: {
      prepared: { localBaseSha: "local-base", root: "/workspace/repo" },
      repository: { remoteBaseSha: "remote-base" },
    },
    id: "task",
    instructionVersion: 1,
    repositoryFullName: "owner/repo",
    repositoryId: "repo",
    revision: 1,
    status: "running",
  } as unknown as CodeTaskRow;
  h.capture.mockResolvedValue({
    changes: [{ contentBase64: "eA==", path: "app.ts", status: "modified" }],
    diff: "actual diff",
    diffTruncated: false,
    manifestDigest: "current-files",
  });
  h.shell.mockResolvedValue(
    JSON.stringify({
      exit_code: 0,
      output_delta: "passed",
      output_truncated: false,
    })
  );
  h.publish.mockResolvedValue({
    branch: "codex/busy-task",
    commitSha: "published-sha",
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
  });
  h.reconcile.mockResolvedValue({
    branch: "codex/busy-task",
    commitSha: "a".repeat(40),
    pullRequestNumber: 1,
    pullRequestUrl: "https://github.com/owner/repo/pull/1",
  });
});

describe("controlled coding tools", () => {
  it("runs workspace commands through the exported tool with the same execution/fence context", async () => {
    const base: FxAgentHostTool = {
      description: "shell",
      execute: h.shell,
      idempotent: false,
      inputSchema: {},
      name: "shell",
    };
    const result = await fencedShell(base, context)("pnpm test");
    expect(result).toEqual({ exitCode: 0, output: "passed", truncated: false });
    expect(h.shell).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          command: "pnpm test",
          cwd: "/workspace/repo",
        }),
      }),
      context
    );
  });

  it("blocks publication until the exact current files have a verification receipt", async () => {
    h.task.execution = {
      ...(h.task.execution as object),
      checks: [{ digest: "older-files", exitCode: 0, instructionVersion: 1 }],
    };
    await expect(
      tool("publish_changes").execute({ summary: "Fix the bug" }, context)
    ).rejects.toThrow("latest files");
    expect(h.publish).not.toHaveBeenCalled();
  });

  it("records real failed check output and labels its draft result accurately", async () => {
    h.shell.mockResolvedValue(
      JSON.stringify({
        exit_code: 1,
        output_delta: "One test failed",
        output_truncated: false,
      })
    );
    await tool("run_verification").execute({ command: "pnpm test" }, context);
    const state = h.task.execution as {
      checks: Array<{ exitCode: number; digest: string }>;
    };
    expect(state.checks[0]).toMatchObject({
      digest: "current-files",
      exitCode: 1,
    });
    await tool("publish_changes").execute(
      { summary: "Change ready for human review; one test failed" },
      context
    );
    expect(h.publish).toHaveBeenCalledOnce();
    expect(h.append).toHaveBeenCalledWith(
      "task",
      "task.ready",
      expect.objectContaining({
        callId: context.executionId,
        files: ["app.ts"],
        verificationPassed: false,
      }),
      expect.anything()
    );
  });

  it("persists the bounded diff marker for both verification and publication", async () => {
    h.capture.mockResolvedValue({
      changes: [{ contentBase64: "eA==", path: "app.ts", status: "modified" }],
      diff: "x".repeat(100_000),
      diffTruncated: true,
      manifestDigest: "current-files",
    });
    await tool("run_verification").execute({ command: "pnpm test" }, context);
    expect((h.task.execution as Record<string, unknown>).diffTruncated).toBe(
      true
    );
    await tool("publish_changes").execute({ summary: "Ready" }, context);
    expect((h.task.execution as Record<string, unknown>).diffTruncated).toBe(
      true
    );
  });

  it("blocks all workspace writes while a correction is queued but not yet applied", async () => {
    h.task.instructionVersion = 2;
    await expect(
      tool("shell").execute(
        { request: { action: "run", command: "touch wrong" } },
        context
      )
    ).rejects.toThrow("New instructions");
    expect(h.shell).not.toHaveBeenCalled();
  });

  it("does not let the agent report unchanged work if files were modified", async () => {
    await expect(
      tool("finish_without_changes").execute(
        { summary: "Nothing to do" },
        context
      )
    ).rejects.toThrow("checkout contains changes");
    expect(h.task.status).toBe("running");
  });

  it("reconciles a previous publication before reporting an empty reversal", async () => {
    const baseSha = "a".repeat(40);
    const publishedSha = "c".repeat(40);
    h.task.branch = "codex/busy-task";
    h.task.commitSha = publishedSha;
    h.task.pullRequestUrl = "https://github.com/owner/repo/pull/1";
    h.task.execution = {
      ...(h.task.execution as object),
      publishedDigest: "old-files",
      repository: {
        baseRef: "main",
        defaultBranch: "main",
        fullName: "owner/repo",
        githubId: "42",
        name: "repo",
        owner: "owner",
        private: true,
        remoteBaseSha: baseSha,
        treeSha: "b".repeat(40),
      },
    };
    h.capture.mockResolvedValue({
      changes: [],
      diff: "",
      manifestDigest: "baseline-files",
    });
    const result = await tool("finish_without_changes").execute(
      { summary: "Everything was restored" },
      context
    );
    expect(h.reconcile).toHaveBeenCalledWith(
      "connection",
      expect.objectContaining({ remoteBaseSha: baseSha }),
      baseSha,
      publishedSha,
      "codex/busy-task",
      expect.objectContaining({ summary: "Everything was restored" })
    );
    expect(result).toMatchObject({
      noChanges: true,
      publicationReconciled: true,
    });
    expect(h.task).toMatchObject({ commitSha: baseSha, status: "ready" });
    expect((h.task.execution as Record<string, unknown>).publishedDigest).toBe(
      "baseline-files"
    );
    expect(h.append).toHaveBeenCalledWith(
      "task",
      "task.ready",
      expect.objectContaining({ publicationReconciled: true }),
      expect.anything()
    );
  });

  it("rejects new operations after cancellation was requested", async () => {
    h.task.status = "cancel_requested";
    await expect(
      tool("run_verification").execute({ command: "pnpm test" }, context)
    ).rejects.toThrow("cancelled");
    expect(h.shell).not.toHaveBeenCalled();
  });
});
