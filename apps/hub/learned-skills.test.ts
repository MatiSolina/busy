import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { appCapabilities } from "./lib/db/schema";

const skill = {
  description: "Build the monthly sales report from the Stripe export.",
  instructions:
    "1. Download the Stripe export for last month.\n2. Group by product.\n3. Send the Excel with send_file.",
  name: "monthly-sales-report",
};

const SKILLS_SH = /skills\.sh/u;
const TAKEN = /already exists/u;
const FULL = /maximum number of enabled capabilities/u;

function defined<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Expected a value.");
  }
  return value;
}

interface Gate {
  reached: () => void;
  release: Promise<void>;
}

/** Transactions wait at these gates, in order: a test lines writers up after their reads. */
const gates: Gate[] = [];

function gate() {
  let reached: () => void = () => undefined;
  let release: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.push({ reached, release: opened });
  return { arrived, release };
}

let client: PGlite;
let learned: typeof import("./lib/skills/learned");
let capabilities: typeof import("./lib/capabilities/store");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL DEFAULT 'Bot', description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '', model text NOT NULL DEFAULT 'm', billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'ready',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Applied in order, as one script: the shared table copies from the per-bot one.
  await client.exec(
    ["0010_bot_capabilities.sql", "0012_app_capabilities.sql"]
      .map((migration) =>
        readFileSync(
          fileURLToPath(new URL(`./drizzle/${migration}`, import.meta.url)),
          "utf8"
        )
      )
      .join("\n")
  );
  const database = drizzle(client, { schema: { appCapabilities } });
  const gated = new Proxy(database, {
    get(target, property, receiver) {
      if (property !== "transaction") {
        return Reflect.get(target, property, receiver);
      }
      return async (...args: Parameters<typeof database.transaction>) => {
        const next = gates.shift();
        if (next) {
          next.reached();
          await next.release;
        }
        return await target.transaction(...args);
      };
    },
  });
  vi.doMock("@/lib/db", () => ({
    appCapabilities,
    db: () => gated,
  }));
  vi.resetModules();
  learned = await import("./lib/skills/learned");
  capabilities = await import("./lib/capabilities/store");
});

beforeEach(async () => {
  gates.length = 0;
  await client.exec(
    "DELETE FROM app_capabilities; DELETE FROM app_capability_migrations;"
  );
});

afterAll(async () => {
  await client.close();
});

describe("learned skills", () => {
  it("saves a new custom skill the bot can load right away", async () => {
    const saved = await learned.saveLearnedSkill(skill);
    expect(saved.created).toBe(true);
    expect(saved.capability).toMatchObject({
      enabled: true,
      kind: "skill",
      name: skill.name,
      origin: null,
    });
    const [runtime] = await capabilities.runtimeSkills();
    expect(runtime).toMatchObject({
      content: skill.instructions,
      name: saved.loadName,
    });
  });

  it("refuses a taken name unless the user approved an update", async () => {
    await learned.saveLearnedSkill(skill);
    await expect(learned.saveLearnedSkill(skill)).rejects.toThrow(TAKEN);
    expect(await capabilities.listCapabilities()).toHaveLength(1);
  });

  it("updates only the named skill and keeps the capability's other skills", async () => {
    await capabilities.createCapability({
      description: "Monthly reporting.",
      kind: "skill",
      name: skill.name,
      skills: [
        {
          content: "Old steps.",
          description: "Old.",
          files: { "references/columns.md": "Product, total." },
          name: skill.name,
        },
        {
          content: "Chart steps.",
          description: "Charts.",
          files: {},
          name: "charts",
        },
      ],
    });
    await learned.saveLearnedSkill({ ...skill, edit: true });
    const [row] = await capabilities.listCapabilities();
    const saved = capabilities.publicCapability(defined(row));
    expect(saved.description).toBe("Monthly reporting.");
    expect(saved.skills.map((entry) => entry.name)).toEqual([
      skill.name,
      "charts",
    ]);
    expect(defined(saved.skills[0])).toMatchObject({
      content: skill.instructions,
      files: { "references/columns.md": "Product, total." },
    });
  });

  it("rewrites its own skill under the same name instead of adding a second one", async () => {
    await learned.saveLearnedSkill(skill);
    const updated = await learned.saveLearnedSkill({
      ...skill,
      edit: true,
      instructions: `${skill.instructions}\n4. Copy the finance team.`,
    });
    expect(updated.created).toBe(false);
    expect(await capabilities.listCapabilities()).toHaveLength(1);
    expect(defined((await capabilities.runtimeSkills())[0]).content).toContain(
      "Copy the finance team"
    );
  });

  it("never overwrites a skill installed from skills.sh", async () => {
    await capabilities.createCapability(
      {
        description: "Reviewed.",
        kind: "skill",
        name: skill.name,
        skills: [
          {
            content: "Reviewed content.",
            description: "Reviewed.",
            files: {},
            name: skill.name,
          },
        ],
      },
      { hash: "a".repeat(64), id: "acme/skills/report", registry: "skills.sh" }
    );
    await expect(
      learned.saveLearnedSkill({ ...skill, edit: true })
    ).rejects.toThrow(SKILLS_SH);
  });

  // PGlite has one connection, so its transactions run one after the other and no lock between
  // connections is exercised here. The gates reproduce the interleaving that lost skills: the
  // learned save starts, a second writer commits from the same starting state, then the save runs.
  it("merges into the row read under the lock, not the catalog read before it", async () => {
    const base = await capabilities.createCapability({
      description: "Monthly reporting.",
      kind: "skill",
      name: skill.name,
      skills: [
        {
          content: "Old steps.",
          description: "Old.",
          files: {},
          name: skill.name,
        },
      ],
    });
    const before = capabilities.publicCapability(base);
    const held = gate();
    const saving = learned.saveLearnedSkill({ ...skill, edit: true });
    await held.arrived;
    // Another writer adds a skill from the state the save started from, and commits first.
    await capabilities.updateCapability(base.id, {
      description: before.description,
      kind: "skill",
      name: before.name,
      skills: [
        ...before.skills,
        {
          content: "Table steps.",
          description: "Tables.",
          files: {},
          name: "tables",
        },
      ],
    });
    held.release();
    await saving;

    const [row] = await capabilities.listCapabilities();
    const saved = capabilities.publicCapability(defined(row));
    expect(saved.skills.map((entry) => entry.name)).toEqual([
      skill.name,
      "tables",
    ]);
    expect(defined(saved.skills[0]).content).toBe(skill.instructions);
  });

  it("serializes two saves that both started from an empty catalog without losing either", async () => {
    const first = gate();
    const second = gate();
    const creating = learned.saveLearnedSkill(skill);
    const updating = learned.saveLearnedSkill({
      ...skill,
      edit: true,
      instructions: `${skill.instructions}\n4. Copy the finance team.`,
    });
    await Promise.all([first.arrived, second.arrived]);
    first.release();
    second.release();
    const [created, updated] = await Promise.all([creating, updating]);

    expect(created.created).toBe(true);
    expect(updated.created).toBe(false);
    expect(updated.capability.id).toBe(created.capability.id);
    const rows = await capabilities.listCapabilities();
    expect(rows).toHaveLength(1);
    expect(capabilities.publicCapability(defined(rows[0])).skills).toEqual([
      expect.objectContaining({
        content: expect.stringContaining("Copy the finance team"),
      }),
    ]);
  });

  it("refuses a name taken after the save started unless it is an approved update", async () => {
    const first = gate();
    const second = gate();
    const creating = learned.saveLearnedSkill(skill);
    const duplicate = learned.saveLearnedSkill(skill);
    await Promise.all([first.arrived, second.arrived]);
    first.release();
    second.release();
    await expect(creating).resolves.toMatchObject({ created: true });
    await expect(duplicate).rejects.toThrow(TAKEN);
    expect(await capabilities.listCapabilities()).toHaveLength(1);
  });

  it("does not overwrite a skills.sh install that lands while the save is waiting", async () => {
    const held = gate();
    const saving = learned.saveLearnedSkill({ ...skill, edit: true });
    await held.arrived;
    await capabilities.installRegistryCapability(
      {
        description: "Reviewed.",
        kind: "skill",
        name: skill.name,
        skills: [
          {
            content: "Reviewed content.",
            description: "Reviewed.",
            files: {},
            name: skill.name,
          },
        ],
      },
      { hash: "b".repeat(64), id: "acme/skills/report", registry: "skills.sh" }
    );
    held.release();
    await expect(saving).rejects.toThrow(SKILLS_SH);
    const [row] = await capabilities.listCapabilities();
    expect(
      defined(capabilities.publicCapability(defined(row)).skills[0]).content
    ).toBe("Reviewed content.");
  });

  it("keeps lowercase matching to learned skills; the general catalog stays case-sensitive", async () => {
    expect(
      learned.learnedSkillSchema.safeParse({ ...skill, name: "Monthly-Report" })
        .success
    ).toBe(false);
    const entry = {
      content: "Steps.",
      description: "Report.",
      files: {},
      name: "report",
    };
    await capabilities.createCapability({
      description: "Upper.",
      kind: "skill",
      name: "Monthly-Sales-Report",
      skills: [entry],
    });
    // No lower(name) index: the general catalog accepts names that differ only in case.
    await capabilities.createCapability({
      description: "Lower.",
      kind: "skill",
      name: "monthly-SALES-report",
      skills: [entry],
    });
    expect(await capabilities.listCapabilities()).toHaveLength(2);
    // A learned save still treats a capability of the same name in any case as taken.
    await expect(learned.saveLearnedSkill(skill)).rejects.toThrow(TAKEN);
  });

  it("checks the app capacity inside the same transaction as the write", async () => {
    const limits = await import("./lib/capabilities/validation");
    const held = gate();
    const saving = learned.saveLearnedSkill(skill);
    await held.arrived;
    for (let index = 0; index < limits.MAX_ENABLED_CAPABILITIES; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: fills the catalog one capability at a time.
      await capabilities.createCapability({
        description: "Filler.",
        kind: "skill",
        name: `filler-${index}`,
        skills: [
          {
            content: "Steps.",
            description: "Filler.",
            files: {},
            name: "filler",
          },
        ],
      });
    }
    held.release();
    await expect(saving).rejects.toThrow(FULL);
  });

  it("validates the proposal shape", () => {
    expect(
      learned.learnedSkillSchema.safeParse({ ...skill, name: "Has Spaces" })
        .success
    ).toBe(false);
    expect(
      learned.learnedSkillSchema.safeParse({
        ...skill,
        instructions: "too short",
      }).success
    ).toBe(false);
  });
});
