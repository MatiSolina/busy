import { describe, expect, it } from "vitest";
import { parseCodeTaskCommand, parseCreateCodeTask } from "./validation";

describe("code task validation", () => {
  it("accepts a bounded task with a repository and AI snapshot", () => {
    expect(
      parseCreateCodeTask({
        ai: {
          agentName: "busy-code-gateway",
          billing: "gateway",
          fast: false,
          model: "openai/gpt-6.1-terra",
        },
        botId: "00000000-0000-4000-8000-000000000002",
        goal: "Keep the return URL through login.",
        id: "00000000-0000-4000-8000-000000000001",
        repository: {
          baseBranch: "main",
          fullName: "acme/web",
          id: "00000000-0000-4000-8000-000000000003",
        },
        repositoryId: "00000000-0000-4000-8000-000000000003",
        sourceCallId: "call-1",
        sourceSessionId: "session-1",
        title: "Fix login redirect",
      })
    ).toMatchObject({
      ai: { billing: "gateway" },
      title: "Fix login redirect",
    });
  });

  it("rejects repository names that can escape the owner/repo contract", () => {
    expect(() =>
      parseCreateCodeTask({
        ai: { billing: "gateway", fast: false, model: "openai/gpt-6.1-terra" },
        botId: "00000000-0000-4000-8000-000000000002",
        goal: "Do it",
        id: "00000000-0000-4000-8000-000000000001",
        repository: {
          baseBranch: "main",
          fullName: "https://evil.test/repo",
          id: "00000000-0000-4000-8000-000000000003",
        },
        repositoryId: "00000000-0000-4000-8000-000000000003",
        sourceCallId: "call-1",
        sourceSessionId: "session-1",
        title: "Fix it",
      })
    ).toThrow();
  });

  it("keeps steering and cancellation inputs strict", () => {
    expect(
      parseCodeTaskCommand({
        kind: "steer",
        messageId: "code-task-1-2",
        text: "Run the migration first.",
      })
    ).toMatchObject({ kind: "steer" });
    expect(
      parseCodeTaskCommand({ kind: "cancel", messageId: "code-task-1-3" })
    ).toMatchObject({ kind: "cancel" });
    expect(() =>
      parseCodeTaskCommand({ kind: "steer", text: "x", unexpected: true })
    ).toThrow();
  });
});
