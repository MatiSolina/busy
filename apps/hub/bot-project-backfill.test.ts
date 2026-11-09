import type { PGlite } from "@electric-sql/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { type BotsDatabase, botsDatabase } from "./lib/bots/test-helpers";

let client: PGlite;
let database: BotsDatabase;

vi.mock("./lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/db")>()),
  db: () => database,
}));

const { backfillBotProjectIds } = await import("./lib/bots/project-backfill");

/** A fake team: projects by name, and which project each deployment lives in. */
const fake = {
  deployments: new Map<string, string>([
    ["dpl_ana", "prj_ana"],
    ["dpl_old", "prj_previous"],
    ["dpl_beto", "prj_ana"],
  ]),
  projects: new Map<string, string>([
    ["bot-ana", "prj_ana"],
    ["bot-carla", "prj_new_carla"],
    ["bot-beto", "prj_ana"],
  ]),
};
const vercel = {
  findProject: vi.fn((name: string) => {
    if (name === "bot-flaky") {
      return Promise.reject(new Error("Vercel get project failed: 502"));
    }
    const id = fake.projects.get(name);
    return Promise.resolve(id ? { id, name } : null);
  }),
  getDeploymentProjectId: vi.fn((id: string) =>
    Promise.resolve(fake.deployments.get(id) ?? null)
  ),
};

async function slugsAndProjects() {
  const { rows } = await client.query<{
    slug: string;
    vercel_project_id: string | null;
  }>("SELECT slug, vercel_project_id FROM bots ORDER BY slug");
  return Object.fromEntries(rows.map((r) => [r.slug, r.vercel_project_id]));
}

beforeAll(async () => {
  ({ client, database } = await botsDatabase());
});

beforeEach(async () => {
  await client.exec("DELETE FROM bots");
  // ana: its deployment lives in bot-ana → linkable. carla: bot-carla is a newer project that doesn't
  // hold carla's deployment (the old one survived elsewhere) → mismatch. dora: no project. eli:
  // never deployed. beto: bot-beto is the same project ana gets → taken. flaky: Vercel errors.
  await client.query(`
    INSERT INTO bots (slug, name, description, deployment_id, created_at) VALUES
      ('ana', 'Ana', '', 'dpl_ana', now() - interval '6 minutes'),
      ('carla', 'Carla', '', 'dpl_old', now() - interval '5 minutes'),
      ('dora', 'Dora', '', 'dpl_dora', now() - interval '4 minutes'),
      ('eli', 'Eli', '', NULL, now() - interval '3 minutes'),
      ('beto', 'Beto', '', 'dpl_beto', now() - interval '2 minutes'),
      ('flaky', 'Flaky', '', 'dpl_flaky', now() - interval '1 minute')
  `);
});

afterAll(async () => {
  await client.close();
});

describe("vercel_project_id backfill (H-08)", () => {
  it("links only rows Vercel proves, and reports the rest", async () => {
    const report = await backfillBotProjectIds(vercel);
    expect(report).toEqual([
      { outcome: "linked", slug: "ana" },
      { outcome: "mismatch", slug: "carla" },
      { outcome: "missing", slug: "dora" },
      { outcome: "no-deployment", slug: "eli" },
      { outcome: "taken", slug: "beto" },
      { outcome: "error", slug: "flaky" },
    ]);
    expect(await slugsAndProjects()).toEqual({
      ana: "prj_ana",
      beto: null,
      carla: null,
      dora: null,
      eli: null,
      flaky: null,
    });
  });

  it("is idempotent: a rerun links nothing twice", async () => {
    await backfillBotProjectIds(vercel);
    const second = await backfillBotProjectIds(vercel);
    expect(second.map((r) => r.slug)).not.toContain("ana");
    expect(second.find((r) => r.slug === "beto")?.outcome).toBe("taken");
    expect((await slugsAndProjects()).ana).toBe("prj_ana");
  });

  it("writes nothing on a dry run", async () => {
    const report = await backfillBotProjectIds(vercel, { dryRun: true });
    expect(report[0]).toEqual({ outcome: "linked", slug: "ana" });
    expect(
      Object.values(await slugsAndProjects()).every((v) => v === null)
    ).toBe(true);
  });
});
