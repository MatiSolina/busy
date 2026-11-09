import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeployment, getDeploymentDetails } from "./client";

async function buildCommand() {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(Response.json({ id: "dpl_1", url: "bot-a.vercel.app" }))
  );
  await createDeployment(
    {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      teamId: "t",
      token: "x",
    },
    "bot-a",
    []
  );
  const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(String(init.body)).projectSettings.buildCommand;
}

afterEach(() => vi.unstubAllEnvs());

describe("bot deployment build command", () => {
  it("is plain eve build by default", async () => {
    expect(await buildCommand()).toBe("eve build");
  });

  it("bundles the compile cache when BOT_COMPILE_CACHE=1", async () => {
    vi.stubEnv("BOT_COMPILE_CACHE", "1");
    expect(await buildCommand()).toBe(
      "eve build && node scripts/compile-cache.mjs"
    );
  });
});

describe("deployment details", () => {
  it("reads timestamps and the newest build log line", async () => {
    const fetchImpl = vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/events")
          ? Response.json([
              { created: 2, payload: { text: "Compiling" }, type: "stdout" },
              { created: 3, payload: { text: "" }, type: "stdout" },
              { created: 1, payload: { text: "Cloning" }, type: "command" },
            ])
          : Response.json({
              buildingAt: 2,
              createdAt: 1,
              readyState: "BUILDING",
            })
      )
    );
    await expect(
      getDeploymentDetails(
        {
          fetchImpl: fetchImpl as unknown as typeof fetch,
          teamId: "t",
          token: "x",
        },
        "dpl_1"
      )
    ).resolves.toEqual({
      buildingAt: 2,
      createdAt: 1,
      lastLine: "Compiling",
      readyAt: null,
      readyState: "BUILDING",
    });
  });

  it("skips the log once the build is READY", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({ createdAt: 1, ready: 9, readyState: "READY" })
      )
    );
    const d = await getDeploymentDetails(
      {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        teamId: "t",
        token: "x",
      },
      "dpl_1"
    );
    expect(d.lastLine).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
