import { describe, expect, it, vi } from "vitest";
import {
  type DeployDeps,
  PROJECT_MISMATCH,
  PROMOTION_LEASE_MS,
  promotionAction,
  refreshStatus,
  startDeploy,
  traceSampleRate,
} from "./deploy";

const bot = {
  billing: "gateway" as const,
  description: "Test bot",
  fast: false,
  id: "bot-id",
  instructions: "Be helpful.",
  model: "openai/gpt-6.1-sol",
  name: "Ana",
  slug: "ana",
};
const settings = {
  botBaseImage: `vcr.vercel.com/test-team/test-project/bot-base@sha256:${"0".repeat(64)}`,
  botsDomain: "bots.test",
  hubPublicKey: "public-key",
  hubUrl: "https://hub.test",
  teamSlug: "team",
  traceSampleRate: 100,
};

function deps(overrides: Partial<DeployDeps> = {}): DeployDeps {
  return {
    addProjectDomain: vi.fn(async () => undefined),
    createDeployment: vi.fn(async () => ({ id: "dpl_1", url: "ana.test" })),
    ensureProject: vi.fn(async () => ({ existed: true })),
    ensureTraceSampling: vi.fn(async () => "updated"),
    getDeploymentState: vi.fn(),
    openMainSession: vi.fn(async () => "session"),
    removeProjectEnv: vi.fn(async () => undefined),
    upsertProjectEnv: vi.fn(async () => undefined),
    warmSession: vi.fn(async () => "accepted"),
    ...overrides,
  };
}

describe("Fast on deploy", () => {
  it.each(["chatgpt", "grok"] as const)(
    "drops Fast on %s plans, which don't honor the priority tier",
    async (billing) => {
      const injected = deps();
      await startDeploy(
        { ...bot, billing, fast: true, model: `${billing}/gpt-6.1-sol` },
        settings,
        injected
      );
      const files = vi.mocked(injected.createDeployment).mock.calls[0]?.[1] as {
        data: string;
        file: string;
      }[];
      const config = files.find((f) => f.file === "agent/config.json");
      expect(JSON.parse(config?.data ?? "{}").fast).toBe(false);
    }
  );
});

describe("bot trace sampling on deploy", () => {
  it("sets the production sampling rule on every deploy", async () => {
    const injected = deps();
    await expect(startDeploy(bot, settings, injected)).resolves.toMatchObject({
      deploymentId: "dpl_1",
    });
    expect(injected.ensureTraceSampling).toHaveBeenCalledWith("bot-ana", 100);
  });

  it("never fails the deploy when sampling cannot be set", async () => {
    const injected = deps({
      ensureTraceSampling: vi.fn(() =>
        Promise.reject(new Error("Vercel set trace sampling failed: 403"))
      ),
    });
    await expect(startDeploy(bot, settings, injected)).resolves.toMatchObject({
      deploymentId: "dpl_1",
    });
    expect(injected.createDeployment).toHaveBeenCalled();
  });

  it("leaves sampling alone when the rate is 0", async () => {
    const injected = deps();
    await startDeploy(bot, { ...settings, traceSampleRate: 0 }, injected);
    expect(injected.ensureTraceSampling).not.toHaveBeenCalled();
  });

  it("parses BOT_TRACE_SAMPLE_RATE as a whole percentage", () => {
    expect(traceSampleRate(undefined)).toBe(100);
    expect(traceSampleRate("")).toBe(100);
    expect(traceSampleRate(" 25 ")).toBe(25);
    expect(traceSampleRate("0")).toBe(0);
    expect(traceSampleRate("101")).toBe(100);
    expect(traceSampleRate("12.5")).toBe(100);
    expect(traceSampleRate("abc")).toBe(100);
  });
});

describe("warm after redeploy", () => {
  const row = {
    deploymentId: "dpl_2",
    id: "bot-id",
    sessionId: "session",
    slug: "ana",
    status: "deploying" as const,
  };

  it("moves the existing session to the new deployment once it is ready", async () => {
    const injected = deps({
      getDeploymentState: vi.fn(async () => "READY" as const),
    });
    await expect(refreshStatus(row, settings, injected)).resolves.toMatchObject(
      {
        status: "ready",
      }
    );
    expect(injected.warmSession).toHaveBeenCalledWith("ana", "session");
  });

  it("does not warm while building, nor fail the refresh when warm fails", async () => {
    const building = deps({
      getDeploymentState: vi.fn(async () => "BUILDING" as const),
    });
    await refreshStatus(row, settings, building);
    expect(building.warmSession).not.toHaveBeenCalled();
    const failing = deps({
      getDeploymentState: vi.fn(async () => "READY" as const),
      warmSession: vi.fn(() => Promise.reject(new Error("503"))),
    });
    await expect(refreshStatus(row, settings, failing)).resolves.toMatchObject({
      status: "ready",
    });
  });
});

describe("main session after deploy (H-02)", () => {
  it("opens it through the main-session helper and never puts it in the patch", async () => {
    const injected = deps({
      getDeploymentState: vi.fn(async () => "READY" as const),
    });
    const patch = await refreshStatus(
      {
        deploymentId: "dpl_3",
        id: "bot-id",
        sessionId: null,
        slug: "ana",
        status: "deploying",
      },
      settings,
      injected
    );
    expect(injected.openMainSession).toHaveBeenCalledWith(
      expect.objectContaining({ deploymentId: "dpl_3", id: "bot-id" })
    );
    // service.update(bot.id, patch) is unconditional: a session in it could overwrite Live's.
    expect(patch).not.toHaveProperty("sessionId");
    expect(patch).toMatchObject({ status: "ready" });
  });

  it("keeps the bot ready when opening fails; the next refresh retries", async () => {
    const injected = deps({
      openMainSession: vi.fn(() => Promise.reject(new Error("not yet"))),
    });
    await expect(
      refreshStatus(
        {
          deploymentId: "dpl_3",
          id: "bot-id",
          sessionId: null,
          slug: "ana",
          status: "ready",
        },
        settings,
        injected
      )
    ).resolves.toEqual({});
  });
});

describe("promotion protocol", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const later = new Date(now.getTime() + PROMOTION_LEASE_MS + 1);
  const free = { deploymentId: null, until: null };
  const ours = { deploymentId: "dpl_2", until: new Date(now.getTime() + 1) };
  const theirs = { deploymentId: "dpl_1", until: new Date(now.getTime() + 1) };
  const base = {
    deploymentId: "dpl_2",
    lease: free,
    now,
    promotion: null,
    state: "READY" as const,
  };
  const alias = (toDeploymentId: string, jobStatus: string) => ({
    jobStatus,
    toDeploymentId,
  });

  it("waits while building and fails on a failed build", () => {
    expect(promotionAction({ ...base, state: "BUILDING" })).toBe("wait");
    expect(promotionAction({ ...base, state: "ERROR" })).toBe("failed");
  });

  it("claims a free lease", () => {
    expect(promotionAction(base)).toBe("claim");
  });

  it("follows its own promotion until Vercel settles it", () => {
    const own = { ...base, lease: ours };
    expect(
      promotionAction({ ...own, promotion: alias("dpl_2", "pending") })
    ).toBe("wait");
    expect(
      promotionAction({ ...own, promotion: alias("dpl_2", "succeeded") })
    ).toBe("promoted");
    expect(
      promotionAction({ ...own, promotion: alias("dpl_2", "skipped") })
    ).toBe("promoted");
    expect(
      promotionAction({ ...own, promotion: alias("dpl_2", "failed") })
    ).toBe("failed");
  });

  it("asks again only after its own request stayed invisible past the lease", () => {
    const own = {
      ...base,
      lease: ours,
      promotion: alias("dpl_1", "succeeded"),
    };
    expect(promotionAction(own)).toBe("wait");
    expect(promotionAction({ ...own, now: later })).toBe("promote");
  });

  it("never overlaps another deployment's promotion that is still running", () => {
    const other = { ...base, lease: theirs };
    expect(
      promotionAction({ ...other, promotion: alias("dpl_1", "in-progress") })
    ).toBe("wait");
    // Even after the lease expired: Vercel says it's still running.
    expect(
      promotionAction({
        ...other,
        now: later,
        promotion: alias("dpl_1", "pending"),
      })
    ).toBe("wait");
    expect(
      promotionAction({ ...other, promotion: alias("dpl_1", "succeeded") })
    ).toBe("claim");
    // Its request never showed up: only the lease's expiry frees it.
    expect(promotionAction({ ...other, promotion: null })).toBe("wait");
    expect(promotionAction({ ...other, now: later, promotion: null })).toBe(
      "claim"
    );
  });
});

describe("project identity on deploy", () => {
  it("refuses to deploy a linked bot into a different project", async () => {
    const injected = deps({
      ensureProject: vi.fn(async () => ({ existed: true, id: "prj_new" })),
    });
    await expect(
      startDeploy({ ...bot, vercelProjectId: "prj_old" }, settings, injected)
    ).rejects.toMatchObject({ issue: { message: PROJECT_MISMATCH } });
    expect(injected.upsertProjectEnv).not.toHaveBeenCalled();
    expect(injected.createDeployment).not.toHaveBeenCalled();
  });

  it("returns the project id with the deployment", async () => {
    const injected = deps({
      ensureProject: vi.fn(async () => ({ existed: false, id: "prj_1" })),
    });
    await expect(startDeploy(bot, settings, injected)).resolves.toEqual({
      deploymentId: "dpl_1",
      projectId: "prj_1",
    });
  });
});
