import { beforeEach, describe, expect, it, vi } from "vitest";
import { restorePlanFromHub } from "./plan-recovery-runtime";

const { hubFetch } = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("./hub", () => ({ hubFetch }));

const packet = {
  botId: "bot-uuid",
  plan: {
    id: "plan-1",
    revision: 2,
    steps: [
      {
        assignee: "agent",
        dependsOn: [],
        execution: {
          id: "exec-1",
          kind: "agent",
          owner: { sessionId: "old-root" },
          planRevision: 2,
          status: "running",
          taskId: "old-task",
        },
        expectedResult: "Verified output",
        id: "work",
        status: "in_progress",
        taskId: "old-task",
        title: "Work",
      },
    ],
    title: "Work",
  },
  predecessorSessionId: "old-root",
  rootSessionId: "new-root",
  version: 1,
};

beforeEach(() => hubFetch.mockReset());

describe("plan recovery runtime lookup", () => {
  it("distinguishes an absent packet from an unavailable service", async () => {
    hubFetch.mockResolvedValueOnce(Response.json(null));
    await expect(restorePlanFromHub("new-root")).resolves.toEqual({
      status: "absent",
    });
    hubFetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(restorePlanFromHub("new-root")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("accepts a Hub-created root without an Eve predecessor and blocks old work", async () => {
    hubFetch.mockResolvedValueOnce(Response.json(packet));
    const result = await restorePlanFromHub("new-root");
    expect(result).toMatchObject({
      plan: {
        steps: [
          {
            status: "blocked",
            taskId: "old-task",
          },
        ],
      },
      status: "restored",
    });
    expect(hubFetch).toHaveBeenCalledWith(
      "/api/bot/recovery?sessionId=new-root",
      undefined
    );
  });

  it("rejects a packet whose predecessor conflicts with Eve lineage", async () => {
    hubFetch.mockResolvedValueOnce(Response.json(packet));
    await expect(
      restorePlanFromHub("new-root", "different-old-root")
    ).resolves.toEqual({
      status: "unavailable",
    });
  });
});
