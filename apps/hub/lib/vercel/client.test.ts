import { describe, expect, it } from "vitest";
import { ensureTraceSampling } from "./client";

interface Call {
  body?: unknown;
  method: string;
  url: URL;
}

function fakeVercel(config: unknown) {
  const calls: Call[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      method,
      url,
    });
    if (url.pathname === "/v9/projects/bot-ana") {
      return Promise.resolve(Response.json({ id: "prj_1" }));
    }
    if (url.pathname === "/v1/drains/tracing/config" && method === "GET") {
      return Promise.resolve(Response.json(config));
    }
    return Promise.resolve(Response.json({}));
  }) as typeof fetch;
  return { calls, cfg: { fetchImpl, teamId: "team_1", token: "token" } };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

describe("ensureTraceSampling", () => {
  it("adds a production rule to a project without tracing", async () => {
    const { calls, cfg } = fakeVercel({ enabled: false, sampling: [] });
    await expect(ensureTraceSampling(cfg, "bot-ana", 100)).resolves.toBe(
      "updated"
    );
    const [put] = puts(calls);
    expect(put?.url.searchParams.get("projectId")).toBe("prj_1");
    expect(put?.url.searchParams.get("teamId")).toBe("team_1");
    expect(put?.body).toEqual({
      enabled: true,
      sampling: [{ env: "production", rate: 1, type: "head_sampling" }],
    });
  });

  it("is a no-op when production already samples at that rate", async () => {
    const { calls, cfg } = fakeVercel({
      enabled: true,
      sampling: [{ env: "production", rate: 1, type: "head_sampling" }],
    });
    await expect(ensureTraceSampling(cfg, "bot-ana", 100)).resolves.toBe(
      "unchanged"
    );
    expect(puts(calls)).toHaveLength(0);
  });

  it("updates the production rate and keeps the other rules", async () => {
    const preview = { env: "preview", rate: 0.1, type: "head_sampling" };
    const path = {
      env: "production",
      rate: 1,
      requestPath: "/api/x",
      type: "head_sampling",
    };
    const { calls, cfg } = fakeVercel({
      enabled: true,
      sampling: [
        preview,
        path,
        { env: "production", rate: 1, type: "head_sampling" },
      ],
    });
    await ensureTraceSampling(cfg, "bot-ana", 25);
    expect(puts(calls)[0]?.body).toEqual({
      enabled: true,
      sampling: [
        preview,
        path,
        { env: "production", rate: 0.25, type: "head_sampling" },
      ],
    });
  });

  it("keeps the implicit everything-at-100% rule of an enabled config", async () => {
    const { calls, cfg } = fakeVercel({ enabled: true, sampling: [] });
    await ensureTraceSampling(cfg, "bot-ana", 50);
    expect(puts(calls)[0]?.body).toEqual({
      enabled: true,
      sampling: [
        { rate: 1, type: "head_sampling" },
        { env: "production", rate: 0.5, type: "head_sampling" },
      ],
    });
  });

  it("refuses to exceed Vercel's rule limit", async () => {
    const sampling = Array.from({ length: 10 }, (_, i) => ({
      env: "preview",
      rate: 1,
      requestPath: `/p${i}`,
      type: "head_sampling",
    }));
    const { calls, cfg } = fakeVercel({ enabled: true, sampling });
    await expect(ensureTraceSampling(cfg, "bot-ana", 100)).rejects.toThrow(
      "no room"
    );
    expect(puts(calls)).toHaveLength(0);
  });
});
