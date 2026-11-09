import { describe, expect, it } from "vitest";
import {
  createDeployment,
  ensureProject,
  findProject,
  getDeploymentProjectId,
  getPromotionStatus,
  promoteDeployment,
} from "./client";

interface Call {
  body?: unknown;
  method: string;
  url: URL;
}

/** Answers by "METHOD /path"; anything else is a 404. */
function fakeVercel(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method,
      url,
    });
    const route = routes[`${method} ${url.pathname}`];
    return Promise.resolve(
      route ? route() : new Response("not found", { status: 404 })
    );
  }) as typeof fetch;
  return { calls, cfg: { fetchImpl, teamId: "team_1", token: "token" } };
}

describe("project identity", () => {
  it("returns the id of the team's project with exactly that name", async () => {
    const { cfg } = fakeVercel({
      "GET /v9/projects/bot-ana": () =>
        Response.json({ accountId: "team_1", id: "prj_1", name: "bot-ana" }),
    });
    await expect(ensureProject(cfg, "bot-ana")).resolves.toEqual({
      existed: true,
      id: "prj_1",
    });
  });

  it("creates a missing project and returns the new id", async () => {
    const { calls, cfg } = fakeVercel({
      "POST /v11/projects": () =>
        Response.json({ accountId: "team_1", id: "prj_new", name: "bot-ana" }),
    });
    await expect(ensureProject(cfg, "bot-ana")).resolves.toEqual({
      existed: false,
      id: "prj_new",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("reads the winner's id after losing a create race", async () => {
    let gets = 0;
    const { cfg } = fakeVercel({
      "GET /v9/projects/bot-ana": () => {
        gets += 1;
        return gets === 1
          ? new Response("not found", { status: 404 })
          : Response.json({ id: "prj_won", name: "bot-ana" });
      },
      "POST /v11/projects": () =>
        new Response("project_name_already_exists", { status: 409 }),
    });
    await expect(ensureProject(cfg, "bot-ana")).resolves.toEqual({
      existed: true,
      id: "prj_won",
    });
  });

  it("refuses a project of another account or with another name", async () => {
    const other = fakeVercel({
      "GET /v9/projects/bot-ana": () =>
        Response.json({ accountId: "team_2", id: "prj_x", name: "bot-ana" }),
    });
    await expect(findProject(other.cfg, "bot-ana")).rejects.toThrow(
      "different project"
    );
    const renamed = fakeVercel({
      "GET /v9/projects/bot-ana": () =>
        Response.json({ id: "prj_x", name: "bot-ana-old" }),
    });
    await expect(findProject(renamed.cfg, "bot-ana")).rejects.toThrow(
      "different project"
    );
  });

  it("reads which project a deployment belongs to", async () => {
    const { cfg } = fakeVercel({
      "GET /v13/deployments/dpl_1": () =>
        Response.json({ projectId: "prj_1", readyState: "READY" }),
    });
    await expect(getDeploymentProjectId(cfg, "dpl_1")).resolves.toBe("prj_1");
    await expect(getDeploymentProjectId(cfg, "dpl_gone")).resolves.toBeNull();
  });
});

describe("unpublished production deployments", () => {
  it("builds for production without assigning its domains", async () => {
    const { calls, cfg } = fakeVercel({
      "POST /v13/deployments": () =>
        Response.json({ id: "dpl_1", url: "bot-ana.vercel.app" }),
    });
    await createDeployment(cfg, "bot-ana", [], true);
    expect(calls[0]?.body).toMatchObject({
      autoAssignCustomDomains: false,
      target: "production",
    });
  });

  it("publishes on its own while explicit promotion is off (the default)", async () => {
    const { calls, cfg } = fakeVercel({
      "POST /v13/deployments": () =>
        Response.json({ id: "dpl_1", url: "bot-ana.vercel.app" }),
    });
    await createDeployment(cfg, "bot-ana", []);
    expect(calls[0]?.body).toMatchObject({
      autoAssignCustomDomains: true,
      target: "production",
    });
  });

  it("promotes the exact deployment of the exact project", async () => {
    const { calls, cfg } = fakeVercel({
      "POST /v10/projects/prj_1/promote/dpl_2": () =>
        new Response(null, { status: 201 }),
    });
    expect(await promoteDeployment(cfg, "prj_1", "dpl_2")).toBe("requested");
    expect(calls[0]?.url.searchParams.get("teamId")).toBe("team_1");
    // A new project's first deploy is already production: Vercel's 409 confirms it.
    const current = fakeVercel({
      "POST /v10/projects/prj_1/promote/dpl_2": () =>
        Response.json(
          {
            error: {
              code: "conflict",
              message:
                "The provided deploymentId (dpl_2) is already the current production deployment.",
            },
          },
          { status: 409 }
        ),
    });
    expect(await promoteDeployment(current.cfg, "prj_1", "dpl_2")).toBe(
      "current"
    );
    const failing = fakeVercel({});
    await expect(
      promoteDeployment(failing.cfg, "prj_1", "dpl_2")
    ).rejects.toThrow("promote deployment failed: 404");
  });

  it("reads the project's latest alias job", async () => {
    const { cfg } = fakeVercel({
      "GET /v9/projects/prj_1": () =>
        Response.json({
          id: "prj_1",
          lastAliasRequest: {
            jobStatus: "in-progress",
            requestedAt: 1,
            toDeploymentId: "dpl_2",
            type: "promote",
          },
        }),
      "GET /v9/projects/prj_2": () => Response.json({ id: "prj_2" }),
    });
    await expect(getPromotionStatus(cfg, "prj_1")).resolves.toEqual({
      jobStatus: "in-progress",
      toDeploymentId: "dpl_2",
    });
    await expect(getPromotionStatus(cfg, "prj_2")).resolves.toBeNull();
  });
});
