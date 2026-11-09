import assert from "node:assert/strict";
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
import type { CapabilityInput, SkillOrigin } from "./lib/capabilities/types";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const input: CapabilityInput = {
  description: "Research workflow",
  kind: "skill",
  name: "research-kit",
  skills: [
    {
      content: "Use sources.",
      description: "Research",
      files: {},
      name: "research",
    },
  ],
  version: "1.0.0",
};
const [inputSkill] = input.skills;
assert(inputSkill);
const origin: SkillOrigin = {
  hash: "a".repeat(64),
  id: "vercel-labs/skills/research",
  registry: "skills.sh",
};

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let capabilities: typeof import("./lib/capabilities/store");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Bot',
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'model/example',
      billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ready',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0010_bot_capabilities.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0012_app_capabilities.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    appCapabilities: schema.appCapabilities,
    db: () => database,
  }));
  vi.resetModules();
  capabilities = await import("./lib/capabilities/store");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database fixture lifecycle keeps setup and teardown grouped.
beforeEach(async () => {
  await client.exec(
    "DELETE FROM app_capabilities; DELETE FROM app_capability_migrations; DELETE FROM bot_capabilities; DELETE FROM bots;"
  );
  await client.exec(
    `INSERT INTO bots (id, slug) VALUES ('${alphaId}', 'alpha'), ('${betaId}', 'beta');`
  );
});

describe("capability store", () => {
  it("persists declarative skills and prefixes runtime names", async () => {
    const row = await capabilities.createCapability(input);
    expect(capabilities.publicCapability(row)).toMatchObject({
      enabled: true,
      kind: "skill",
      name: "research-kit",
    });
    const [skill] = await capabilities.runtimeSkills();
    expect(skill).toMatchObject({
      content: "Use sources.",
      // biome-ignore lint/performance/useTopLevelRegex: test fixture regex is scoped to this mock request shape.
      name: expect.stringMatching(/^s_[0-9a-f]{16}_research$/u),
    });
  });

  it("is shared across bots and survives bot deletion", async () => {
    const row = await capabilities.createCapability(input);
    await expect(
      capabilities.removeCapability(row.id)
    ).resolves.toBeUndefined();
    const shared = await capabilities.createCapability(input);
    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}';`);
    await expect(
      database.select().from(schema.appCapabilities)
    ).resolves.toHaveLength(1);
    expect(shared.id).not.toBe(row.id);
  });

  it("supports enable toggles without exposing disabled skills", async () => {
    const row = await capabilities.createCapability(input);
    await capabilities.updateCapability(row.id, { enabled: false });
    await expect(capabilities.runtimeSkills()).resolves.toEqual([]);
    const edited = await capabilities.updateCapability(row.id, {
      ...input,
      description: "Edited while disabled",
    });
    expect(edited.enabled).toBe(false);
    await capabilities.updateCapability(row.id, { enabled: true });
    await expect(capabilities.runtimeSkills()).resolves.toHaveLength(1);
  });

  it("rejects duplicate capability names with a conflict", async () => {
    await capabilities.createCapability(input);
    await expect(capabilities.createCapability(input)).rejects.toThrow(
      "already exists"
    );
  });

  it("installs a registry revision idempotently, re-enables it, and protects local edits", async () => {
    const installed = await capabilities.installRegistryCapability(
      { ...input, name: "research-abcdef1234" },
      origin
    );
    const repeated = await capabilities.installRegistryCapability(
      { ...input, name: "research-abcdef1234" },
      origin
    );
    expect(repeated.reused).toBe(true);
    expect(repeated.row.id).toBe(installed.row.id);
    await expect(
      capabilities.installRegistryCapability(
        { ...input, name: "research-abcdef1234" },
        { ...origin, hash: "b".repeat(64) }
      )
    ).rejects.toThrow("different revision");
    await capabilities.updateCapability(installed.row.id, { enabled: false });
    const reenabled = await capabilities.installRegistryCapability(
      { ...input, name: "research-abcdef1234" },
      origin
    );
    expect(reenabled.reused).toBe(true);
    expect(reenabled.row.enabled).toBe(true);
    const unchanged = await capabilities.updateCapability(installed.row.id, {
      ...input,
      name: "research-abcdef1234",
    });
    expect(unchanged.origin?.modified).not.toBe(true);
    await capabilities.updateCapability(installed.row.id, {
      ...input,
      description: "Edited",
      name: "research-abcdef1234",
    });
    await expect(
      capabilities.installRegistryCapability(
        { ...input, name: "research-abcdef1234" },
        origin
      )
    ).rejects.toThrow("local edits");
  });

  it("rejects re-enabling a 33rd capability", async () => {
    // biome-ignore lint/style/noIncrementDecrement: fixture counter is intentionally local to the test scenario.
    for (let index = 0; index < 32; index++) {
      // biome-ignore lint/performance/noAwaitInLoops: fixture operations are intentionally sequential to preserve deterministic ordering.
      await capabilities.createCapability({ ...input, name: `cap-${index}` });
    }
    const disabledId = "33333333-3333-4333-8333-333333333333";
    await database.insert(schema.appCapabilities).values({
      description: "Disabled",
      enabled: false,
      id: disabledId,
      kind: "skill",
      name: "disabled",
      skills: input.skills,
    });
    await expect(
      capabilities.updateCapability(disabledId, { enabled: true })
    ).rejects.toThrow("maximum number of enabled capabilities");
  });

  it("limits the enabled skill aggregate to 256", async () => {
    const skills = Array.from({ length: 16 }, (_, index) => ({
      ...inputSkill,
      name: `s${index}`,
    }));
    for (let index = 0; index < 16; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: create fixtures sequentially to preserve the aggregate limit under test.
      await capabilities.createCapability({
        ...input,
        name: `bundle-${index}`,
        skills,
      });
    }
    await expect(
      capabilities.createCapability({
        ...input,
        name: "bundle-overflow",
        skills,
      })
    ).rejects.toThrow("maximum number of enabled skills");
  });

  it("limits the serialized enabled runtime payload to 2 MiB", async () => {
    const large = { ...inputSkill, content: "x".repeat(191_000) };
    for (let index = 0; index < 10; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: create fixtures sequentially to preserve the serialized payload limit under test.
      await capabilities.createCapability({
        ...input,
        name: `large-${index}`,
        skills: [{ ...large, name: `large-skill-${index}` }],
      });
    }
    await expect(
      capabilities.createCapability({
        ...input,
        name: "large-overflow",
        skills: [{ ...large, name: "large-overflow-skill" }],
      })
    ).rejects.toThrow("Enabled capability content");
  });

  it("migrates colliding bot names without dropping rows and is idempotent after deletion", async () => {
    await client.exec(
      "DELETE FROM app_capabilities; DELETE FROM app_capability_migrations; DELETE FROM bot_capabilities;"
    );
    const firstId = "44444444-4444-4444-8444-444444444444";
    const secondId = "55555555-5555-4555-8555-555555555555";
    const values = (id: string, botId: string) =>
      `('${id}', '${botId}', 'skill', 'same-name', 'Description', true, '${JSON.stringify(input.skills).replaceAll("'", "''")}'::jsonb)`;
    await client.exec(
      `INSERT INTO bot_capabilities (id, bot_id, kind, name, description, enabled, skills) VALUES ${values(firstId, alphaId)}, ${values(secondId, betaId)};`
    );
    const migration = readFileSync(
      fileURLToPath(
        new URL("./drizzle/0012_app_capabilities.sql", import.meta.url)
      ),
      "utf8"
    );
    await client.exec(migration);
    const migrated = await database.select().from(schema.appCapabilities);
    expect(migrated).toHaveLength(2);
    expect(new Set(migrated.map((row) => row.name)).size).toBe(2);
    await client.exec(`DELETE FROM app_capabilities WHERE id = '${secondId}';`);
    await client.exec(migration);
    expect(await database.select().from(schema.appCapabilities)).toHaveLength(
      1
    );
  });

  it.each([
    {
      content: "Use sources.",
      count: 33,
      label: "capabilities",
      limit: "32",
      skillCount: 1,
    },
    {
      content: "Use sources.",
      count: 17,
      label: "skills",
      limit: "256",
      skillCount: 16,
    },
    {
      content: "x".repeat(191_000),
      count: 12,
      label: "content",
      limit: "2097152",
      skillCount: 1,
    },
  ])(
    "rolls back a legacy union that exceeds shared $label limits",
    async ({ count, skillCount, content, limit }) => {
      await database.insert(schema.botCapabilities).values(
        Array.from({ length: count }, (_, index) => ({
          botId: index % 2 === 0 ? alphaId : betaId,
          description: "Legacy workflow",
          kind: "skill" as const,
          name: `legacy-${index}`,
          skills: Array.from({ length: skillCount }, (_skill, skillIndex) => ({
            content,
            description: "Legacy workflow",
            files: {},
            name: `workflow-${skillIndex}`,
          })),
        }))
      );
      const migration = readFileSync(
        new URL("./drizzle/0012_app_capabilities.sql", import.meta.url),
        "utf8"
      );

      await expect(client.exec(migration)).rejects.toThrow(limit);

      expect(await database.select().from(schema.appCapabilities)).toEqual([]);
      expect(await database.select().from(schema.botCapabilities)).toHaveLength(
        count
      );
      const markers = await client.query(
        "SELECT source_id FROM app_capability_migrations"
      );
      expect(markers.rows).toEqual([]);
    }
  );
});
