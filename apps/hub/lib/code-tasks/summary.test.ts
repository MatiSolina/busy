import { describe, expect, it } from "vitest";
import { type PublicCodeTask, publicCodeTaskSummary } from "./types";

const task: PublicCodeTask = {
  agentName: "agent",
  appliedInstructionVersion: 2,
  billing: "token-pass",
  botId: "11111111-1111-4111-8111-111111111111",
  botSlug: "builder",
  branch: "codex/busy-task",
  commitSha: "a".repeat(40),
  createdAt: "2026-11-02T00:00:00.000Z",
  durableSessionId: "durable-session",
  error: null,
  execution: {
    hugeLog: "do not expose this in the chat polling response",
    token: "must not be exposed",
  },
  finishedAt: null,
  goal: "Fix the login form",
  id: "55555555-5555-4555-8555-555555555555",
  instructionVersion: 2,
  lastStreamCursor: 10,
  model: "model",
  phase: "editing",
  prUrl: null,
  repository: {
    baseBranch: "main",
    fullName: "acme/widgets",
    id: "22222222-2222-4222-8222-222222222222",
  },
  revision: 3,
  status: "running",
  summary: "Editing the requested files.",
  title: "Fix login",
  updatedAt: "2026-11-02T00:01:00.000Z",
};

describe("code task summary view", () => {
  it("keeps chat polling small and excludes execution/events payloads", () => {
    const summary = publicCodeTaskSummary(task);
    expect(summary).toEqual({
      botSlug: "builder",
      error: null,
      id: task.id,
      phase: "editing",
      prUrl: null,
      repository: task.repository,
      status: "running",
      summary: task.summary,
      title: task.title,
      updatedAt: task.updatedAt,
    });
    expect(summary).not.toHaveProperty("execution");
    expect(summary).not.toHaveProperty("goal");
    expect(summary).not.toHaveProperty("events");
  });
});
