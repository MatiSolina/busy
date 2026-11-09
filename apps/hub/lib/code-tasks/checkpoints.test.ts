import { describe, expect, it, it as test } from "vitest";
import { buildCodeTaskCheckpoints } from "./checkpoints";
import type { PublicCodeEvent, PublicCodeTask } from "./types";

const task: PublicCodeTask = {
  agentName: "Busy",
  appliedInstructionVersion: 1,
  billing: "gateway",
  botId: "bot-1",
  branch: null,
  commitSha: null,
  createdAt: "2026-11-03T12:00:00.000Z",
  durableSessionId: "session-1",
  error: null,
  execution: { files: ["final.ts"] },
  finishedAt: null,
  goal: "Fix the bug",
  id: "task-1",
  instructionVersion: 1,
  lastStreamCursor: 0,
  model: "model",
  phase: "editing",
  prUrl: null,
  repository: { baseBranch: "main", fullName: "acme/app", id: "repo-1" },
  revision: 1,
  status: "running",
  summary: null,
  title: "Fix bug",
  updatedAt: "2026-11-03T12:00:00.000Z",
};

function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  createdAt = `2026-11-03T12:00:0${seq}.000Z`
): PublicCodeEvent {
  return {
    createdAt,
    data,
    revision: 1,
    seq,
    taskId: task.id,
    type,
  };
}

describe("buildCodeTaskCheckpoints", () => {
  it("collapses a tool and its call-bound domain event into one checkpoint", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(3, "repository.prepared", {
        callId: "prepare-1",
        root: "/workspace/repo",
      }),
      event(1, "tool.start", {
        callId: "prepare-1",
        command: "{}",
        name: "prepare_repository",
      }),
      event(2, "tool.end", {
        callId: "prepare-1",
        isError: false,
        name: "prepare_repository",
        output: "ready",
      }),
    ]);

    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]).toMatchObject({
      eventSeqs: [1, 2, 3],
      kind: "repository",
      state: "completed",
      title: "Prepared repository",
    });
  });

  it("preserves a failed verification when its wrapper tool ends successfully", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(1, "tool.start", {
        callId: "check-1",
        command: '{"command":"pnpm test"}',
        name: "run_verification",
      }),
      event(2, "verification", {
        callId: "check-1",
        command: "pnpm test",
        exitCode: 1,
        files: ["repo/src/app.ts"],
        output: "failed",
      }),
      event(3, "tool.end", {
        callId: "check-1",
        isError: false,
        name: "run_verification",
        output: "receipt returned",
      }),
    ]);

    expect(result.checkpoints).toHaveLength(1);
    expect(result.checkpoints[0]).toMatchObject({
      files: ["repo/src/app.ts"],
      kind: "check",
      state: "failed",
    });
  });

  it("keeps resumed work in the same run and increments only on an actual start", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(1, "agent.working", {
        message: "Working",
        messageId: "turn-1",
        resumed: false,
      }),
      event(2, "agent.message", { message: "first", messageId: "turn-1" }),
      event(3, "agent.working", {
        message: "Resuming the saved task",
        messageId: "resume-1",
        resumed: true,
      }),
      event(4, "agent.message", {
        message: "continued",
        messageId: "resume-1",
      }),
      event(5, "agent.working", {
        message: "Working again",
        messageId: "turn-2",
        resumed: false,
      }),
      event(6, "agent.message", { message: "second run", messageId: "turn-2" }),
    ]);

    expect(result.runs).toBe(2);
    expect(
      result.checkpoints.map(({ run, title }) => ({ run, title }))
    ).toEqual([
      { run: 1, title: "firstcontinued" },
      { run: 2, title: "second run" },
    ]);
  });

  it("pairs parallel calls by callId even when their tool names match", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(1, "tool.start", {
        callId: "read-a",
        command: '{"path":"repo/a.ts"}',
        name: "read_file",
      }),
      event(2, "tool.start", {
        callId: "read-b",
        command: '{"path":"repo/b.ts"}',
        name: "read_file",
      }),
      event(3, "tool.end", {
        callId: "read-b",
        isError: false,
        name: "read_file",
        output: "b",
      }),
      event(4, "tool.end", {
        callId: "read-a",
        isError: false,
        name: "read_file",
        output: "a",
      }),
    ]);

    expect(result.checkpoints).toHaveLength(2);
    expect(
      result.checkpoints.map(({ eventSeqs, files }) => ({ eventSeqs, files }))
    ).toEqual([
      { eventSeqs: [1, 4], files: ["a.ts"] },
      { eventSeqs: [2, 3], files: ["b.ts"] },
    ]);
  });

  it("preserves repository-relative domain files and never copies task final files", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(1, "verification", {
        command: "pnpm test",
        exitCode: 0,
        files: ["repo/src/a.ts", "src/b.ts", "../secret"],
        output: "passed",
      }),
      event(2, "task.ready", {
        files: ["repo/src/c.ts"],
        noChanges: false,
        summary: "Ready",
      }),
    ]);

    expect(result.checkpoints.map(({ files }) => files)).toEqual([
      ["repo/src/a.ts", "src/b.ts"],
      ["repo/src/c.ts"],
    ]);
    expect(
      result.checkpoints.every(({ files }) => !files.includes("final.ts"))
    ).toBe(true);
  });

  it.each([
    ["ready", "cancelled"],
    ["failed", "failed"],
    ["cancelled", "cancelled"],
  ] as const)(
    "resolves an orphan tool for terminal status %s",
    (status, state) => {
      const result = buildCodeTaskCheckpoints({ ...task, status }, [
        event(1, "tool.start", {
          callId: "orphan",
          command: "{}",
          name: "shell",
        }),
      ]);

      expect(result.checkpoints[0]?.state).toBe(state);
    }
  );

  it("sorts out-of-order events and ignores duplicate sequence numbers", () => {
    const result = buildCodeTaskCheckpoints(task, [
      event(3, "tool.end", {
        callId: "call-1",
        isError: false,
        name: "shell",
        output: "done",
      }),
      event(1, "tool.start", {
        callId: "call-1",
        command: '{"command":"pwd"}',
        name: "shell",
      }),
      event(2, "agent.message", { message: "note", messageId: "m-1" }),
      event(2, "agent.message", { message: "duplicate", messageId: "m-1" }),
    ]);

    expect(result.checkpoints.map(({ eventSeqs }) => eventSeqs)).toEqual([
      [1, 3],
      [2],
    ]);
    expect(result.checkpoints[0]?.elapsedSeconds).toBe(3);
    expect(result.checkpoints[1]?.title).toBe("duplicate");
  });
});

test("strips a file-tool workspace prefix only once for a real repo directory", () => {
  const result = buildCodeTaskCheckpoints(task, [
    event(1, "tool.start", {
      callId: "absolute",
      command: JSON.stringify({ path: "/workspace/repo/repo/src/a.ts" }),
      name: "read_file",
    }),
    event(2, "tool.start", {
      callId: "relative",
      command: JSON.stringify({ path: "repo/repo/src/a.ts" }),
      name: "read_file",
    }),
  ]);
  expect(result.checkpoints.map(({ files }) => files)).toEqual([
    ["repo/src/a.ts"],
    ["repo/src/a.ts"],
  ]);
});
