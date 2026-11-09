import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  DEPLOY_DEADLINE_MS,
  DEPLOY_TIMED_OUT,
  DEPLOY_UNCONFIRMED,
  PROJECT_MISMATCH,
} from "./lib/bots/deploy";
import {
  type BotsDatabase,
  botsDatabase,
  deployMigration,
  migration,
} from "./lib/bots/test-helpers";
import { type BotRow, bots } from "./lib/db/schema";

let client: PGlite;
let database: BotsDatabase;

/**
 * A fake Vercel team. Deployments are created unpublished; only promoteDeployment changes what is
 * production, through an alias job that settles at once or when the test says so.
 */
const vercel = vi.hoisted(() => {
  const state = {
    autoSettle: true as boolean,
    beforePromote: null as null | ((deploymentId: string) => Promise<void>),
    created: [] as string[],
    deployments: new Map<string, { projectId: string; state: string }>(),
    lastAlias: new Map<string, { jobStatus: string; toDeploymentId: string }>(),
    nextDeployment: 1,
    nextProject: 1,
    production: new Map<string, string>(),
    projects: new Map<string, string>(),
    promotions: [] as string[],
    sessionFails: false,
    sessions: 0,
    stateFails: false as boolean,
  };
  const reset = () => {
    state.autoSettle = true;
    state.beforePromote = null;
    state.created = [];
    state.deployments.clear();
    state.lastAlias.clear();
    state.nextDeployment = 1;
    state.nextProject = 1;
    state.production.clear();
    state.projects.clear();
    state.promotions = [];
    state.sessions = 0;
    state.sessionFails = false;
    state.stateFails = false;
  };
  const settle = (projectId: string, jobStatus = "succeeded") => {
    const alias = state.lastAlias.get(projectId);
    if (!alias) {
      throw new Error("no promotion to settle");
    }
    alias.jobStatus = jobStatus;
    if (jobStatus === "succeeded") {
      state.production.set(projectId, alias.toDeploymentId);
    }
  };
  const ensureProject = (_cfg: unknown, name: string) => {
    const existing = state.projects.get(name);
    if (existing) {
      return Promise.resolve({ existed: true, id: existing });
    }
    const id = `prj_${state.nextProject}`;
    state.nextProject += 1;
    state.projects.set(name, id);
    return Promise.resolve({ existed: false, id });
  };
  const api = {
    addProjectDomain: () => Promise.resolve(),
    createDeployment: (_cfg: unknown, name: string) => {
      const id = `dpl_${state.nextDeployment}`;
      state.nextDeployment += 1;
      const projectId = state.projects.get(name);
      if (!projectId) {
        throw new Error("no project");
      }
      state.deployments.set(id, { projectId, state: "BUILDING" });
      state.created.push(id);
      return Promise.resolve({ id, url: `${id}.vercel.app` });
    },
    deleteProject: () => Promise.resolve(),
    ensureProject,
    ensureTraceSampling: () => Promise.resolve("unchanged"),
    getDeploymentDetails: () => Promise.reject(new Error("unused")),
    getDeploymentProjectId: (_cfg: unknown, id: string) =>
      Promise.resolve(state.deployments.get(id)?.projectId ?? null),
    getDeploymentState: (_cfg: unknown, id: string) => {
      if (state.stateFails) {
        return Promise.reject(new Error("Vercel get deployment failed: 502"));
      }
      return Promise.resolve(state.deployments.get(id)?.state ?? "ERROR");
    },
    getPromotionStatus: (_cfg: unknown, projectId: string) =>
      Promise.resolve(
        state.lastAlias.get(projectId)
          ? { ...state.lastAlias.get(projectId) }
          : null
      ),
    promoteDeployment: async (
      _cfg: unknown,
      projectId: string,
      deploymentId: string
    ) => {
      state.promotions.push(deploymentId);
      await state.beforePromote?.(deploymentId);
      state.lastAlias.set(projectId, {
        jobStatus: "pending",
        toDeploymentId: deploymentId,
      });
      if (state.autoSettle) {
        settle(projectId);
      }
    },
    removeProjectEnv: () => Promise.resolve(),
    setFunctionMemory: () => Promise.resolve(),
    upsertProjectEnv: () => Promise.resolve(),
  };
  return { api, reset, settle, state };
});

vi.mock("./lib/vercel/client", () => ({
  ...vercel.api,
  explicitPromotion: () => process.env.BOT_DEPLOY_PROMOTION === "on",
}));
vi.mock("./lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/db")>()),
  db: () => database,
}));
vi.mock("./lib/eve/client", () => ({
  createSession: () => {
    vercel.state.sessions += 1;
    return vercel.state.sessionFails
      ? Promise.reject(new Error("eve unreachable"))
      : Promise.resolve(`session_${vercel.state.sessions}`);
  },
  endSession: () => Promise.resolve(true),
  prewarmSession: () => Promise.resolve("accepted"),
}));
vi.mock("./lib/hub-token", () => ({ hubPublicKey: () => "public-key" }));
vi.mock("./lib/chat/store", () => ({
  botCall: (slug: string) => ({ slug }),
}));

const service = await import("./lib/bots/service");

const input = (name: string) => ({
  avatar: null,
  billing: "gateway" as const,
  description: "Reviews contracts.",
  fast: false,
  instructions: "v1",
  model: "moonshotai/kimi-k3",
  name,
});

const targetOf = (row: BotRow) => ({
  botId: row.id,
  generation: row.deployGeneration,
});

async function rowOf(id: string): Promise<BotRow> {
  const [row] = await database.select().from(bots).where(eq(bots.id, id));
  if (!row) {
    throw new Error("row gone");
  }
  return row;
}

const ready = (deploymentId: string) => {
  const deployment = vercel.state.deployments.get(deploymentId);
  if (!deployment) {
    throw new Error("no deployment");
  }
  deployment.state = "READY";
};

/** Polls one run until it says done (bounded), like deployBotWorkflow does every 10 s. */
async function runUntilDone(
  target: { botId: string; generation: number },
  now?: () => Date
) {
  for (let i = 0; i < 10; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: The workflow polls sequentially.
    if ((await service.refreshBot(target, now)) === "done") {
      return;
    }
  }
  throw new Error("run never finished");
}

beforeAll(async () => {
  // The deploy opens the main session through the 0026 session helper: its tables, real.
  ({ client, database } = await botsDatabase(async (legacy) => {
    await legacy.exec(`
      CREATE TABLE messages (
        id uuid PRIMARY KEY, bot_id uuid NOT NULL, delivery_id text, status text NOT NULL
      );
      CREATE TABLE events (
        session_id text NOT NULL, bot_id uuid NOT NULL, type text NOT NULL, data jsonb NOT NULL
      );
    `);
    await legacy.exec(migration("0026_session_bindings.sql"));
  }));
  vi.stubEnv("BOTS_DOMAIN", "bots.test");
  vi.stubEnv(
    "BOT_BASE_IMAGE",
    `vcr.vercel.com/test-team/test-project/bot-base@sha256:${"0".repeat(64)}`
  );
  vi.stubEnv("HUB_URL", "https://hub.test");
  vi.stubEnv("VERCEL_TEAM_SLUG", "team");
  vi.stubEnv("VERCEL_TEAM_ID", "team_1");
  vi.stubEnv("VERCEL_TOKEN", "token");
  // These tests cover the explicit promotion protocol; the default (off) has its own test below.
  vi.stubEnv("BOT_DEPLOY_PROMOTION", "on");
});

beforeEach(async () => {
  vercel.reset();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await client.exec("DELETE FROM bots");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("deploy generations (H-03)", () => {
  it("builds once, promotes the exact deployment, then becomes ready with a session", async () => {
    const bot = await service.insertBot(input("Ana"));
    expect(bot).toMatchObject({ deployGeneration: 1, status: "creating" });
    expect(bot.deployStartedAt).toBeInstanceOf(Date);

    await expect(service.deployBot(targetOf(bot))).resolves.toBe("started");
    const deploying = await rowOf(bot.id);
    expect(deploying).toMatchObject({
      deploymentId: "dpl_1",
      status: "deploying",
      vercelProjectId: "prj_1",
    });
    // Built but not published.
    expect(vercel.state.production.size).toBe(0);
    await expect(service.refreshBot(targetOf(bot))).resolves.toBe("continue");

    ready("dpl_1");
    await runUntilDone(targetOf(bot));
    expect(await rowOf(bot.id)).toMatchObject({
      deploymentId: "dpl_1",
      promotionDeploymentId: null,
      sessionId: "session_1",
      status: "ready",
      url: "https://ana.bots.test",
    });
    expect(vercel.state.production.get("prj_1")).toBe("dpl_1");
    expect(vercel.state.promotions).toEqual(["dpl_1"]);
  });

  it("without explicit promotion, a READY deployment is production and nothing is promoted", async () => {
    vi.stubEnv("BOT_DEPLOY_PROMOTION", "");
    try {
      const bot = await service.insertBot(input("Ana"));
      await expect(service.deployBot(targetOf(bot))).resolves.toBe("started");
      ready("dpl_1");
      await runUntilDone(targetOf(bot));
      expect(await rowOf(bot.id)).toMatchObject({
        deploymentId: "dpl_1",
        status: "ready",
        vercelProjectId: "prj_1",
      });
      expect(vercel.state.promotions).toEqual([]);
    } finally {
      vi.stubEnv("BOT_DEPLOY_PROMOTION", "on");
    }
  });

  it("a failed start leaves its own generation failed, never a newer one", async () => {
    const bot = await service.insertBot(input("Ana"));
    const { bot: newer } = await service.patchBot(
      bot,
      { instructions: "v2" },
      {}
    );
    expect(newer.deployGeneration).toBe(2);
    // The start of generation 1 failed after generation 2 was saved: generation 2 is untouched.
    expect(await service.markDeployStartFailed(bot)).toMatchObject({
      deployGeneration: 2,
      status: "creating",
    });
    const failed = await service.markDeployStartFailed(newer);
    expect(failed).toMatchObject({
      deployGeneration: 2,
      error: "Busy could not deploy this bot.",
      status: "failed",
    });
  });

  it("ready without a session is a deploy success; a session error never fails it", async () => {
    const bot = await service.insertBot(input("Ana"));
    await service.deployBot(targetOf(bot));
    ready("dpl_1");
    vercel.state.sessionFails = true;
    let now = Date.now();
    const clock = () => new Date(now);
    await service.refreshBot(targetOf(bot), clock);
    await service.refreshBot(targetOf(bot), clock);
    expect(await rowOf(bot.id)).toMatchObject({
      sessionId: null,
      status: "ready",
    });
    // Past the deadline the run ends; the row stays ready for the session helper.
    now += DEPLOY_DEADLINE_MS + 60_000;
    await expect(service.refreshBot(targetOf(bot), clock)).resolves.toBe(
      "done"
    );
    expect(await rowOf(bot.id)).toMatchObject({ error: null, status: "ready" });
  });

  it("a build still running at the deadline becomes a retryable failure", async () => {
    const bot = await service.insertBot(input("Ana"));
    await service.deployBot(targetOf(bot));
    const late = () => new Date(Date.now() + DEPLOY_DEADLINE_MS + 60_000);
    await expect(service.refreshBot(targetOf(bot), late)).resolves.toBe("done");
    expect(await rowOf(bot.id)).toMatchObject({
      deploymentId: "dpl_1",
      error: DEPLOY_TIMED_OUT,
      status: "failed",
    });
    expect(vercel.state.promotions).toEqual([]);
  });

  it("an ambiguous Vercel answer changes nothing (the run checks again)", async () => {
    const bot = await service.insertBot(input("Ana"));
    await service.deployBot(targetOf(bot));
    vercel.state.stateFails = true;
    await expect(service.refreshBot(targetOf(bot))).rejects.toThrow("502");
    expect(await rowOf(bot.id)).toMatchObject({ status: "deploying" });
  });

  it("an explicit retry starts a new generation from creating or failed only", async () => {
    const bot = await service.insertBot(input("Ana"));
    const { bot: retried, redeploy } = await service.patchBot(
      bot,
      {},
      { retry: true }
    );
    expect(redeploy).toBe(true);
    expect(retried).toMatchObject({ deployGeneration: 2, status: "creating" });
    await service.deployBot(targetOf(retried));
    ready("dpl_1");
    await runUntilDone(targetOf(retried));
    await expect(
      service.patchBot(await rowOf(bot.id), {}, { retry: true })
    ).rejects.toBeInstanceOf(service.DeployRetryConflictError);
  });
});

describe("deploy fencing and promotion (H-04)", () => {
  it("D1 finishes after a PATCH started D2: D1 is never published nor written over D2", async () => {
    const bot = await service.insertBot(input("Ana"));
    const g1 = targetOf(bot);
    await service.deployBot(g1);
    // PATCH while D1 builds.
    const { bot: patched } = await service.patchBot(
      await rowOf(bot.id),
      { instructions: "v2" },
      {}
    );
    const g2 = targetOf(patched);
    ready("dpl_1");
    // The old run sees READY for D1 but its generation is gone.
    await expect(service.refreshBot(g1)).resolves.toBe("done");
    expect(vercel.state.promotions).toEqual([]);
    expect(await rowOf(bot.id)).toMatchObject({
      deployGeneration: 2,
      deploymentId: null,
      status: "creating",
    });

    await service.deployBot(g2);
    // A late ERROR of D1 doesn't touch D2 either.
    vercel.state.deployments.set("dpl_1", {
      projectId: "prj_1",
      state: "ERROR",
    });
    await expect(service.refreshBot(g1)).resolves.toBe("done");
    ready("dpl_2");
    await runUntilDone(g2);
    expect(await rowOf(bot.id)).toMatchObject({
      deploymentId: "dpl_2",
      instructions: "v2",
      status: "ready",
    });
    expect(vercel.state.production.get("prj_1")).toBe("dpl_2");
    expect(vercel.state.promotions).toEqual(["dpl_2"]);
  });

  it("a PATCH between the promotion claim and the call: production converges to the winner", async () => {
    const bot = await service.insertBot(input("Ana"));
    const g1 = targetOf(bot);
    await service.deployBot(g1);
    ready("dpl_1");
    let patched: BotRow | undefined;
    vercel.state.autoSettle = false;
    vercel.state.beforePromote = async (deploymentId) => {
      if (deploymentId === "dpl_1") {
        ({ bot: patched } = await service.patchBot(
          await rowOf(bot.id),
          { model: "openai/gpt-6.1-sol" },
          {}
        ));
      }
    };
    // Claims the lease for D1 and sends the promotion; the PATCH lands in between.
    await expect(service.refreshBot(g1)).resolves.toBe("continue");
    if (!patched) {
      throw new Error("patch did not run");
    }
    const g2 = targetOf(patched);
    expect(await rowOf(bot.id)).toMatchObject({
      deployGeneration: 2,
      promotionDeploymentId: "dpl_1",
    });
    // The old run stops; it never writes ready for generation 1.
    await expect(service.refreshBot(g1)).resolves.toBe("done");

    await service.deployBot(g2);
    ready("dpl_2");
    // D1's alias job is still running: D2 waits instead of overlapping it.
    await expect(service.refreshBot(g2)).resolves.toBe("continue");
    expect(vercel.state.promotions).toEqual(["dpl_1"]);
    vercel.settle("prj_1");
    expect(vercel.state.production.get("prj_1")).toBe("dpl_1");

    vercel.state.autoSettle = true;
    await runUntilDone(g2);
    expect(vercel.state.promotions).toEqual(["dpl_1", "dpl_2"]);
    expect(vercel.state.production.get("prj_1")).toBe("dpl_2");
    expect(await rowOf(bot.id)).toMatchObject({
      deployGeneration: 2,
      deploymentId: "dpl_2",
      model: "openai/gpt-6.1-sol",
      promotionDeploymentId: null,
      status: "ready",
    });
  });

  it("a promotion Vercel fails is a visible failure that releases the lease", async () => {
    const bot = await service.insertBot(input("Ana"));
    await service.deployBot(targetOf(bot));
    ready("dpl_1");
    vercel.state.autoSettle = false;
    await service.refreshBot(targetOf(bot));
    vercel.settle("prj_1", "failed");
    await expect(service.refreshBot(targetOf(bot))).resolves.toBe("done");
    expect(await rowOf(bot.id)).toMatchObject({
      promotionDeploymentId: null,
      status: "failed",
    });
  });

  it("two runs of one generation record a single deployment", async () => {
    const bot = await service.insertBot(input("Ana"));
    const results = await Promise.all([
      service.deployBot(targetOf(bot)),
      service.deployBot(targetOf(bot)),
    ]);
    expect(results.sort()).toEqual(["stale", "started"]);
    const row = await rowOf(bot.id);
    expect(vercel.state.created).toContain(row.deploymentId);
    // The loser's deployment exists in Vercel but is never promoted.
    ready("dpl_1");
    ready("dpl_2");
    await runUntilDone(targetOf(bot));
    expect(vercel.state.promotions).toEqual([row.deploymentId]);
  });
});

describe("deploy reconciler (H-03)", () => {
  const stale = (row: BotRow, minutes: number) =>
    client.query(
      "UPDATE bots SET deploy_started_at = now() - make_interval(mins => $2) WHERE id = $1",
      [row.id, minutes]
    );

  it("adopts a stale READY deployment instead of building another", async () => {
    const bot = await service.insertBot(input("Ana"));
    await service.deployBot(targetOf(bot));
    ready("dpl_1");
    await stale(bot, 60);
    const runs: { botId: string; generation: number }[] = [];
    const startRun = (t: { botId: string; generation: number }) => {
      runs.push(t);
      return Promise.resolve();
    };
    expect(await service.reconcileDeploys(startRun)).toMatchObject({
      restarted: 1,
    });
    // A second pass right after doesn't start another run.
    expect(await service.reconcileDeploys(startRun)).toMatchObject({
      restarted: 0,
    });
    expect(runs).toEqual([targetOf(bot)]);

    const [run] = runs;
    if (!run) {
      throw new Error("no run");
    }
    await expect(service.deployBot(run)).resolves.toBe("adopted");
    await runUntilDone(run);
    expect(vercel.state.created).toEqual(["dpl_1"]);
    expect(await rowOf(bot.id)).toMatchObject({
      deploymentId: "dpl_1",
      deployRecoveries: 1,
      status: "ready",
    });
  });

  it("restarts an orphaned creating row once per pass, then gives up visibly", async () => {
    const bot = await service.insertBot(input("Ana"));
    let started = 0;
    const startRun = () => {
      started += 1;
      return Promise.resolve();
    };
    for (let pass = 0; pass < 3; pass += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each pass ages the row, then reconciles.
      await stale(bot, 15);
      await service.reconcileDeploys(startRun);
      await service.reconcileDeploys(startRun);
    }
    expect(started).toBe(3);
    await stale(bot, 15);
    expect(await service.reconcileDeploys(startRun)).toMatchObject({
      failed: 1,
    });
    expect(await rowOf(bot.id)).toMatchObject({
      deployGeneration: 1,
      error: DEPLOY_UNCONFIRMED,
      status: "failed",
    });
  });

  it("never touches a fresh deploy", async () => {
    await service.insertBot(input("Ana"));
    const startRun = vi.fn(() => Promise.resolve());
    expect(await service.reconcileDeploys(startRun)).toEqual({
      failed: 0,
      restarted: 0,
      startErrors: 0,
    });
    expect(startRun).not.toHaveBeenCalled();
  });
});

describe("bot project identity on deploy (H-08)", () => {
  it("refuses to deploy a linked bot into another project named bot-<slug>", async () => {
    const bot = await service.insertBot(input("Ana"));
    await client.query("UPDATE bots SET vercel_project_id = $2 WHERE id = $1", [
      bot.id,
      "prj_original",
    ]);
    await expect(service.deployBot(targetOf(bot))).resolves.toBe("failed");
    expect(await rowOf(bot.id)).toMatchObject({
      error: PROJECT_MISMATCH,
      status: "failed",
      vercelProjectId: "prj_original",
    });
    expect(vercel.state.created).toEqual([]);
  });

  it("refuses a project already linked to another bot", async () => {
    const other = await service.insertBot(input("Other"));
    await client.query(
      "UPDATE bots SET vercel_project_id = 'prj_1' WHERE id = $1",
      [other.id]
    );
    const bot = await service.insertBot(input("Ana"));
    await expect(service.deployBot(targetOf(bot))).resolves.toBe("failed");
    expect(await rowOf(bot.id)).toMatchObject({
      error: PROJECT_MISMATCH,
      status: "failed",
      vercelProjectId: null,
    });
  });
});

describe("migration 0028", () => {
  it("ages in-flight rows, is repeatable and keeps one bot per project", async () => {
    const { client: fresh } = await botsDatabase(async (legacy) => {
      await legacy.query(`
        INSERT INTO bots (slug, name, description, status, updated_at) VALUES
          ('building', 'B', '', 'deploying', now() - interval '2 hours'),
          ('live', 'L', '', 'ready', now() - interval '2 hours')
      `);
    });
    try {
      await fresh.exec(deployMigration());
      const { rows } = await fresh.query<{
        deploy_generation: number;
        slug: string;
        started: boolean;
      }>(
        "SELECT slug, deploy_generation, deploy_started_at IS NOT NULL AS started FROM bots ORDER BY slug"
      );
      expect(rows).toEqual([
        { deploy_generation: 0, slug: "building", started: true },
        { deploy_generation: 0, slug: "live", started: false },
      ]);
      await fresh.exec(
        "UPDATE bots SET vercel_project_id = 'prj_1' WHERE slug = 'live'"
      );
      await expect(
        fresh.exec(
          "UPDATE bots SET vercel_project_id = 'prj_1' WHERE slug = 'building'"
        )
      ).rejects.toMatchObject({ code: "23505" });
      await expect(
        fresh.exec("UPDATE bots SET deploy_generation = -1")
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await fresh.close();
    }
  });
});
