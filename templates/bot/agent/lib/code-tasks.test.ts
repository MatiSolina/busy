import { describe, expect, it } from "vitest";
import { isCodeTaskCompletion } from "./code-task-guards";
import {
  codeTaskSummary,
  getCodeTask,
  stableCodeTaskCommandId,
  stableCodeTaskId,
  verifyCodeTaskOwnership,
} from "./code-tasks";

const CODE_TASK_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

describe("code task ids", () => {
  it("accepts a task whose current phase is not known yet", () => {
    expect(codeTaskSummary.shape.phase.safeParse(null).success).toBe(true);
  });

  it("recognizes the hub completion principal namespace", () => {
    const auth = {
      current: {
        principalId:
          "busy-hub:hub:code-task:55555555-5555-4555-8555-555555555555",
        principalType: "service",
      },
    };
    expect(isCodeTaskCompletion(auth)).toBe(true);
  });

  it("is stable for a retried call and separates operation kinds", () => {
    const task = stableCodeTaskId("session-1", "call-1");
    expect(task).toBe(stableCodeTaskId("session-1", "call-1"));
    expect(task).not.toBe(stableCodeTaskId("session-1", "call-2"));
    expect(
      stableCodeTaskCommandId("session-1", "call-1", task, "steer")
    ).not.toBe(stableCodeTaskCommandId("session-1", "call-1", task, "cancel"));
    expect(task).toMatch(CODE_TASK_ID);
  });

  it("surfaces a bounded actionable hub error without forwarding secret-like text", async () => {
    const fetcher = async () =>
      Response.json(
        { error: "Select an enabled repository first." },
        { status: 409 }
      );
    await expect(
      getCodeTask("8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a", fetcher)
    ).resolves.toEqual({
      error: "Select an enabled repository first.",
    });
    const secretFetcher = async () =>
      Response.json(
        { error: "Authorization bearer token=secret" },
        { status: 409 }
      );
    await expect(
      getCodeTask("8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a", secretFetcher)
    ).resolves.toEqual({
      error: "That code task is not available for this operation.",
    });
  });

  it("requires the hub's scoped ownership proof before binding a code task", async () => {
    const fetcher = (path: string) => {
      expect(path).toContain("sourceSessionId=root-session");
      return Promise.resolve(
        Response.json({
          binding: {
            sourceSessionId: "root-session",
            taskId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
          },
        })
      );
    };
    await expect(
      verifyCodeTaskOwnership(
        "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
        "root-session",
        fetcher
      )
    ).resolves.toBe(true);
    await expect(
      verifyCodeTaskOwnership(
        "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
        "other-session",
        async () =>
          Response.json({
            binding: {
              sourceSessionId: "root-session",
              taskId: "8d6f4d9c-f3cc-4b8b-8c89-7622c21d2c6a",
            },
          })
      )
    ).resolves.toBe(false);
  });
});
