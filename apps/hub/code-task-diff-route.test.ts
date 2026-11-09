import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/code-tasks/[id]/diff/route";

const mocks = vi.hoisted(() => ({ getPublicTask: vi.fn() }));

vi.mock("@/lib/code-tasks/store", () => ({
  getPublicTask: mocks.getPublicTask,
}));

const taskId = "55555555-5555-4555-8555-555555555555";

function task() {
  return {
    agentName: "Busy",
    appliedInstructionVersion: 1,
    billing: "token-pass",
    botId: "11111111-1111-4111-8111-111111111111",
    branch: "codex/busy-task",
    commitSha: null,
    createdAt: "2026-11-03T00:00:00.000Z",
    durableSessionId: null,
    error: null,
    execution: {
      diff: "diff --git a/README.md b/README.md\n@@ -1 +1 @@\n-old\n+new",
      files: ["README.md"],
    },
    finishedAt: null,
    goal: "Inspect",
    id: taskId,
    instructionVersion: 1,
    lastStreamCursor: 0,
    model: "model",
    phase: null,
    prUrl: null,
    repository: { baseBranch: "main", fullName: "acme/repo", id: "repo" },
    revision: 1,
    status: "ready",
    summary: null,
    title: "Inspect",
    updatedAt: "2026-11-03T00:00:00.000Z",
  };
}

describe("code task diff route", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects an invalid task id", async () => {
    const response = await GET(
      new Request("https://busy.test/api/code-tasks/not-a-uuid/diff"),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(response.status).toBe(400);
    expect(mocks.getPublicTask).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing task", async () => {
    mocks.getPublicTask.mockResolvedValue(null);
    const response = await GET(
      new Request(`https://busy.test/api/code-tasks/${taskId}/diff`),
      { params: Promise.resolve({ id: taskId }) }
    );
    expect(response.status).toBe(404);
  });

  it("returns only the stable diff contract", async () => {
    mocks.getPublicTask.mockResolvedValue(task());
    const response = await GET(
      new Request(`https://busy.test/api/code-tasks/${taskId}/diff`),
      { params: Promise.resolve({ id: taskId }) }
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      files: [
        expect.objectContaining({
          additions: 1,
          deletions: 1,
          path: "README.md",
          status: "modified",
        }),
      ],
      source: "workspace",
      truncated: false,
    });
  });
});
