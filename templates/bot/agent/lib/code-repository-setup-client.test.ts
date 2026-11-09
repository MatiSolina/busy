import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCodeRepositoryStatus } from "./code-repository-setup-client";

const hubFetch = vi.hoisted(() =>
  vi.fn<(path: string, init?: RequestInit) => Promise<Response>>()
);

vi.mock("./hub", () => ({ hubFetch }));

const repositoryId = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  hubFetch.mockReset();
});

describe("conversational repository setup status", () => {
  it("returns a verified repository without starting a task", async () => {
    hubFetch.mockResolvedValue(
      Response.json({
        ready: true,
        repository: { fullName: "acme/widgets", id: repositoryId },
      })
    );
    await expect(
      getCodeRepositoryStatus("session-1", repositoryId)
    ).resolves.toEqual({
      ready: true,
      repository: { fullName: "acme/widgets", id: repositoryId },
    });
    expect(hubFetch).toHaveBeenCalledWith(
      `/api/bot/code-repository?sourceSessionId=session-1&repositoryId=${repositoryId}`,
      {}
    );
    expect(
      hubFetch.mock.calls.some(([path]) => path === "/api/bot/code-tasks")
    ).toBe(false);
  });

  it.each(["connect_github", "select_repository", "reconnect_github"] as const)(
    "preserves the server-owned blocked reason: %s",
    async (reason) => {
      hubFetch.mockResolvedValue(Response.json({ ready: false, reason }));
      await expect(getCodeRepositoryStatus("session-1")).resolves.toEqual({
        ready: false,
        reason,
      });
    }
  );

  it("turns a revoked-session response into a safe error and never forwards secrets", async () => {
    hubFetch.mockResolvedValue(
      Response.json(
        { error: "Authorization bearer token=github_pat_secret" },
        { status: 403 }
      )
    );
    await expect(
      getCodeRepositoryStatus("session-1", repositoryId)
    ).resolves.toEqual({
      error: "This conversation cannot prepare a code repository.",
    });
  });

  it("surfaces service failures without asking or starting anything", async () => {
    hubFetch.mockRejectedValue(new Error("network down"));
    await expect(getCodeRepositoryStatus("session-1")).resolves.toEqual({
      error: "Couldn't reach the code repository service.",
    });
  });
});
