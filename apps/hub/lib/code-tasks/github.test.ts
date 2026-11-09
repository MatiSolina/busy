import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  downloadRepositoryArchive,
  listGitHubRepositories,
  publishChanges,
  reconcilePublication,
  resolveRepository,
} from "./github";

const h = vi.hoisted(() => ({
  freshRegisteredToken: vi.fn(),
  McpOAuthProvider: class {
    data: Record<string, unknown>;
    constructor(data: Record<string, unknown>) {
      this.data = data;
    }
  },
  withConnection: vi.fn(),
}));

vi.mock("../mcp/store", () => ({ withConnection: h.withConnection }));
vi.mock("../mcp/registered-oauth", () => ({
  freshRegisteredToken: h.freshRegisteredToken,
}));
vi.mock("../mcp/oauth", () => ({ McpOAuthProvider: h.McpOAuthProvider }));

beforeEach(() => {
  vi.clearAllMocks();
  h.withConnection.mockImplementation(
    async (
      _id: string,
      run: (row: unknown, data: unknown) => Promise<unknown>
    ) => {
      const result = (await run(
        { catalogId: "github", id: "conn", status: "connected" },
        { redirectOrigin: "https://busy.test", registeredProvider: "github" }
      )) as { value: string };
      return result.value;
    }
  );
  h.freshRegisteredToken.mockResolvedValue({ token: "github-token" });
});

describe("GitHub code-task transport", () => {
  it("lists a paginated repository page and preserves available write permissions", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        Response.json([
          {
            default_branch: "main",
            full_name: "acme/writable",
            id: 42,
            permissions: { push: true },
            private: true,
          },
          {
            default_branch: "main",
            full_name: "acme/read-only",
            id: 43,
            permissions: { push: false },
            private: false,
          },
          {
            default_branch: "main",
            full_name: "acme/unknown-permissions",
            id: 44,
            private: false,
          },
        ])
      )
    );
    await expect(listGitHubRepositories("conn", fetcher, 2)).resolves.toEqual([
      {
        canPush: true,
        defaultBranch: "main",
        fullName: "acme/writable",
        githubId: "42",
        private: true,
      },
      {
        canPush: false,
        defaultBranch: "main",
        fullName: "acme/read-only",
        githubId: "43",
        private: false,
      },
      {
        defaultBranch: "main",
        fullName: "acme/unknown-permissions",
        githubId: "44",
        private: false,
      },
    ]);
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/user/repos?per_page=100&page=2&sort=updated"
    );
  });

  it("freezes a branch ref to its commit and tree SHA", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/repos/acme/widgets")) {
        return Promise.resolve(
          Response.json({
            default_branch: "trunk",
            full_name: "acme/widgets",
            id: 42,
            permissions: { push: true },
            private: true,
          })
        );
      }
      return Promise.resolve(
        Response.json({
          commit: { tree: { sha: "b".repeat(40) } },
          sha: "a".repeat(40),
        })
      );
    });
    const meta = await resolveRepository(
      "conn",
      "acme/widgets",
      "feature/base",
      fetcher
    );
    expect(meta).toMatchObject({
      baseRef: "feature/base",
      fullName: "acme/widgets",
      private: true,
      remoteBaseSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    });
    expect(calls).toHaveLength(2);
  });

  it("rejects unowned or protected publication branches before contacting GitHub", async () => {
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    };
    await expect(
      publishChanges("conn", meta, "a".repeat(40), "main", [])
    ).rejects.toThrow("not owned");
    expect(h.withConnection).not.toHaveBeenCalled();
  });

  it("reconciles the fixed codeload redirect without forwarding the bearer", async () => {
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(
          Response.redirect(
            "https://codeload.github.com/acme/widgets/tar.gz/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            302
          )
        );
      }
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3])));
    });
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: false,
      remoteBaseSha: "a".repeat(40),
      treeSha: "b".repeat(40),
    };
    await expect(
      downloadRepositoryArchive(meta, "conn", fetcher)
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts GitHub's legacy codeload redirect without forwarding the bearer", async () => {
    const baseSha = "a".repeat(40);
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(
          Response.redirect(
            `https://codeload.github.com/acme/widgets/legacy.tar.gz/${baseSha}`,
            302
          )
        );
      }
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return Promise.resolve(new Response(new Uint8Array([4, 5, 6])));
    });
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: false,
      remoteBaseSha: baseSha,
      treeSha: "b".repeat(40),
    };
    await expect(
      downloadRepositoryArchive(meta, "conn", fetcher)
    ).resolves.toEqual(new Uint8Array([4, 5, 6]));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts a signed private codeload redirect without forwarding the OAuth bearer", async () => {
    const baseSha = "a".repeat(40);
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (fetcher.mock.calls.length === 1) {
        return Promise.resolve(
          Response.redirect(
            `https://codeload.github.com/acme/widgets/legacy.tar.gz/${baseSha}?token=temporary-signed-value`,
            302
          )
        );
      }
      const headers = new Headers(init?.headers);
      expect(headers.has("Authorization")).toBe(false);
      expect(headers.get("Accept")).toBe("application/octet-stream");
      return Promise.resolve(new Response(new Uint8Array([7, 8, 9])));
    });
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: baseSha,
      treeSha: "b".repeat(40),
    };
    await expect(
      downloadRepositoryArchive(meta, "conn", fetcher)
    ).resolves.toEqual(new Uint8Array([7, 8, 9]));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("token=");
  });

  it.each([
    [true, "?other=value"],
    [true, "?token=first&token=second"],
    [true, "?token="],
    [true, "?token=temporary%20signed%20value"],
    [true, `?token=${"a".repeat(4097)}`],
    [false, "?token=unexpected-public-token"],
  ] as const)(
    "rejects an unsafe codeload query (private: %s): %s",
    async (isPrivate, query) => {
      const baseSha = "a".repeat(40);
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.redirect(
            `https://codeload.github.com/acme/widgets/legacy.tar.gz/${baseSha}${query}`,
            302
          )
        )
      );
      const meta = {
        baseRef: "trunk",
        defaultBranch: "trunk",
        fullName: "acme/widgets",
        githubId: "42",
        name: "widgets",
        owner: "acme",
        private: isPrivate,
        remoteBaseSha: baseSha,
        treeSha: "b".repeat(40),
      };
      await expect(
        downloadRepositoryArchive(meta, "conn", fetcher)
      ).rejects.toMatchObject({
        code: "archive_redirect_invalid",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  );

  it("resets an owned publication branch and updates its draft PR when a reversal is empty", async () => {
    const baseSha = "a".repeat(40);
    const publishedSha = "c".repeat(40);
    const restoredSha = "d".repeat(40);
    const pr = { html_url: "https://github.test/pr/12", number: 12 };
    let refPatchBody: Record<string, unknown> | null = null;
    let restoreCommitBody: Record<string, unknown> | null = null;
    let pullRequestPatchBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-reversal")) {
          if (method === "GET") {
            return Promise.resolve(
              Response.json({ object: { sha: publishedSha } })
            );
          }
          throw new Error(`unexpected singular ref method: ${method}`);
        }
        if (url.pathname.endsWith("/git/refs/heads/codex/busy-reversal")) {
          if (method !== "PATCH") {
            throw new Error(`unexpected plural ref method: ${method}`);
          }
          refPatchBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url.pathname.endsWith(`/git/commits/${publishedSha}`)) {
          return Promise.resolve(
            Response.json({
              parents: [{ sha: baseSha }],
              tree: { sha: "e".repeat(40) },
            })
          );
        }
        if (url.pathname.endsWith("/git/commits")) {
          if (method !== "POST") {
            throw new Error(`unexpected commit method: ${method}`);
          }
          restoreCommitBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return Promise.resolve(Response.json({ sha: restoredSha }));
        }
        if (url.pathname.endsWith("/pulls")) {
          return Promise.resolve(Response.json([pr]));
        }
        if (url.pathname.endsWith("/pulls/12")) {
          if (method !== "PATCH") {
            throw new Error(`unexpected pull request method: ${method}`);
          }
          pullRequestPatchBody = JSON.parse(String(init?.body)) as Record<
            string,
            unknown
          >;
          return Promise.resolve(Response.json(pr));
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: baseSha,
      treeSha: "b".repeat(40),
    };
    await expect(
      reconcilePublication(
        "conn",
        meta,
        baseSha,
        publishedSha,
        "codex/busy-reversal",
        { summary: "Everything was restored" },
        fetcher
      )
    ).resolves.toEqual({
      branch: "codex/busy-reversal",
      commitSha: restoredSha,
      pullRequestNumber: 12,
      pullRequestUrl: pr.html_url,
    });
    expect(refPatchBody).toEqual({ force: false, sha: restoredSha });
    expect(restoreCommitBody).toEqual({
      message: "Busy: restore codex/busy-reversal",
      parents: [publishedSha],
      tree: "b".repeat(40),
    });
    expect(
      (pullRequestPatchBody as Record<string, unknown> | null)?.body
    ).toContain("Everything was restored");
    expect(fetcher.mock.calls).toHaveLength(7);
  });

  it("recognizes a restore commit after a lost reconciliation response", async () => {
    const baseSha = "a".repeat(40);
    const publishedSha = "c".repeat(40);
    const restoredSha = "d".repeat(40);
    const pr = { html_url: "https://github.test/pr/13", number: 13 };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-retry")) {
          return Promise.resolve(
            Response.json({ object: { sha: restoredSha } })
          );
        }
        if (url.pathname.endsWith(`/git/commits/${restoredSha}`)) {
          return Promise.resolve(
            Response.json({
              parents: [{ sha: publishedSha }],
              tree: { sha: "b".repeat(40) },
            })
          );
        }
        if (url.pathname.endsWith("/pulls")) {
          return Promise.resolve(Response.json([pr]));
        }
        if (url.pathname.endsWith("/pulls/13")) {
          if (method !== "PATCH") {
            throw new Error(`unexpected pull request method: ${method}`);
          }
          return Promise.resolve(Response.json(pr));
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: baseSha,
      treeSha: "b".repeat(40),
    };
    await expect(
      reconcilePublication(
        "conn",
        meta,
        baseSha,
        publishedSha,
        "codex/busy-retry",
        { summary: "Everything was restored" },
        fetcher
      )
    ).resolves.toMatchObject({
      commitSha: restoredSha,
      pullRequestNumber: 13,
    });
    expect(
      fetcher.mock.calls.some(([input, request]) => {
        const path = new URL(String(input)).pathname;
        return (
          path.endsWith("/git/commits") && (request?.method ?? "GET") === "POST"
        );
      })
    ).toBe(false);
    expect(
      fetcher.mock.calls.some(([input, request]) => {
        const path = new URL(String(input)).pathname;
        return (
          path.includes("/git/refs/heads/") &&
          (request?.method ?? "GET") === "PATCH"
        );
      })
    ).toBe(false);
  });

  it("does not create a second restore commit when the task already points at one", async () => {
    const baseSha = "a".repeat(40);
    const restoredSha = "d".repeat(40);
    const pr = { html_url: "https://github.test/pr/14", number: 14 };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-repeat")) {
          return Promise.resolve(
            Response.json({ object: { sha: restoredSha } })
          );
        }
        if (url.pathname.endsWith(`/git/commits/${restoredSha}`)) {
          return Promise.resolve(
            Response.json({
              parents: [{ sha: "c".repeat(40) }],
              tree: { sha: "b".repeat(40) },
            })
          );
        }
        if (url.pathname.endsWith("/pulls")) {
          return Promise.resolve(Response.json([pr]));
        }
        if (url.pathname.endsWith("/pulls/14")) {
          if (method !== "PATCH") {
            throw new Error(`unexpected pull request method: ${method}`);
          }
          return Promise.resolve(Response.json(pr));
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: baseSha,
      treeSha: "b".repeat(40),
    };
    await expect(
      reconcilePublication(
        "conn",
        meta,
        baseSha,
        restoredSha,
        "codex/busy-repeat",
        { summary: "Everything was restored again" },
        fetcher
      )
    ).resolves.toMatchObject({
      commitSha: restoredSha,
      pullRequestNumber: 14,
    });
    expect(
      fetcher.mock.calls.some(([input]) =>
        new URL(String(input)).pathname.endsWith("/git/commits")
      )
    ).toBe(false);
    expect(
      fetcher.mock.calls.some(([input, request]) => {
        const path = new URL(String(input)).pathname;
        return path.includes("/git/refs/heads/") && request?.method === "PATCH";
      })
    ).toBe(false);
  });

  it("reuses a lost-ack commit and existing PR without creating duplicates", async () => {
    const expectedRemoteHead = "a".repeat(40);
    const existingCommit = "c".repeat(40);
    const treeSha = "e".repeat(40);
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: expectedRemoteHead,
      treeSha: "b".repeat(40),
    };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-lost-ack")) {
          return Promise.resolve(
            Response.json({ object: { sha: existingCommit } })
          );
        }
        if (url.pathname.endsWith(`/git/commits/${existingCommit}`)) {
          return Promise.resolve(
            Response.json({
              parents: [{ sha: expectedRemoteHead }],
              tree: { sha: treeSha },
            })
          );
        }
        if (url.pathname.endsWith("/git/blobs")) {
          return Promise.resolve(Response.json({ sha: "d".repeat(40) }));
        }
        if (url.pathname.endsWith("/git/trees")) {
          return Promise.resolve(Response.json({ sha: treeSha }));
        }
        if (url.pathname.endsWith("/pulls")) {
          return Promise.resolve(
            Response.json([{ html_url: "https://github.test/pr/7", number: 7 }])
          );
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    const receipt = await publishChanges(
      "conn",
      meta,
      expectedRemoteHead,
      "codex/busy-lost-ack",
      [
        {
          contentBase64: Buffer.from("updated").toString("base64"),
          path: "README.md",
          status: "modified",
        },
      ],
      fetcher
    );
    expect(receipt).toEqual({
      branch: "codex/busy-lost-ack",
      commitSha: existingCommit,
      pullRequestNumber: 7,
      pullRequestUrl: "https://github.test/pr/7",
    });
    expect(
      fetcher.mock.calls.some(
        ([input, init]) =>
          String(input).endsWith("/git/commits") && init?.method === "POST"
      )
    ).toBe(false);
    expect(
      fetcher.mock.calls.some(([input]) => String(input).includes("/pulls?"))
    ).toBe(true);
  });

  it("builds cumulative deletion changes from the original remote tree", async () => {
    const expectedRemoteHead = "a".repeat(40);
    const originalTree = "b".repeat(40);
    const nextTree = "e".repeat(40);
    const nextCommit = "f".repeat(40);
    const treeBodies: Record<string, unknown>[] = [];
    const meta = {
      baseRef: "trunk",
      defaultBranch: "trunk",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: expectedRemoteHead,
      treeSha: originalTree,
    };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-cumulative")) {
          return Promise.resolve(
            Response.json({ object: { sha: expectedRemoteHead } })
          );
        }
        if (url.pathname.endsWith("/git/trees")) {
          treeBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>
          );
          return Promise.resolve(Response.json({ sha: nextTree }));
        }
        if (url.pathname.endsWith("/git/commits")) {
          return Promise.resolve(Response.json({ sha: nextCommit }));
        }
        if (url.pathname.endsWith("/git/refs/heads/codex/busy-cumulative")) {
          return Promise.resolve(Response.json({}));
        }
        if (url.pathname.endsWith("/pulls")) {
          if (method === "GET") {
            return Promise.resolve(Response.json([]));
          }
          return Promise.resolve(
            Response.json({
              html_url: "https://github.test/pr/8",
              number: 8,
            })
          );
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    const receipt = await publishChanges(
      "conn",
      meta,
      expectedRemoteHead,
      "codex/busy-cumulative",
      [{ path: "removed.txt", status: "deleted" }],
      fetcher
    );
    expect(receipt.commitSha).toBe(nextCommit);
    expect(treeBodies).toEqual([
      {
        base_tree: originalTree,
        tree: [
          { mode: "100644", path: "removed.txt", sha: null, type: "blob" },
        ],
      },
    ]);
  });

  it("uses the selected base ref when creating the draft PR", async () => {
    const expectedRemoteHead = "a".repeat(40);
    const prBodies: Record<string, unknown>[] = [];
    const meta = {
      baseRef: "feature/base",
      defaultBranch: "main",
      fullName: "acme/widgets",
      githubId: "42",
      name: "widgets",
      owner: "acme",
      private: true,
      remoteBaseSha: expectedRemoteHead,
      treeSha: "b".repeat(40),
    };
    const fetcher = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname.endsWith("/git/ref/heads/codex/busy-base-ref")) {
          return Promise.resolve(Response.json({}, { status: 404 }));
        }
        if (url.pathname.endsWith("/git/trees")) {
          return Promise.resolve(Response.json({ sha: "e".repeat(40) }));
        }
        if (url.pathname.endsWith("/git/commits")) {
          return Promise.resolve(Response.json({ sha: "f".repeat(40) }));
        }
        if (url.pathname.endsWith("/git/refs")) {
          return Promise.resolve(Response.json({}));
        }
        if (url.pathname.endsWith("/pulls")) {
          if (method === "GET") {
            return Promise.resolve(Response.json([]));
          }
          prBodies.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>
          );
          return Promise.resolve(
            Response.json({ html_url: "https://github.test/pr/9", number: 9 })
          );
        }
        throw new Error(`unexpected GitHub request: ${method} ${url}`);
      }
    );
    await publishChanges(
      "conn",
      meta,
      expectedRemoteHead,
      "codex/busy-base-ref",
      [{ path: "removed.txt", status: "deleted" }],
      fetcher
    );
    expect(prBodies).toHaveLength(1);
    expect(prBodies[0]?.base).toBe("feature/base");
  });
});
