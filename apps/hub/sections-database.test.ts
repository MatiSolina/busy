import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
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
import { botSectionMemberships, botSections, bots } from "./lib/db/schema";

const schema = { botSectionMemberships, botSections, bots };

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const alphaCreated = "2026-11-02T12:00:00.000Z";
const betaCreated = "2026-11-02T12:01:00.000Z";

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/sections/store");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0014_bot_sections.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    botSectionMemberships: schema.botSectionMemberships,
    botSections: schema.botSections,
    bots: schema.bots,
    db: () => database,
  }));
  vi.resetModules();
  store = await import("./lib/sections/store");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM bot_section_memberships; DELETE FROM bot_sections; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug, name, created_at) VALUES
      ('${alphaId}', 'alpha', 'Alpha', '${alphaCreated}'),
      ('${betaId}', 'beta', 'Beta', '${betaCreated}');
  `);
});

afterAll(async () => {
  await client.close();
});

describe("section persistence invariants", () => {
  it("keeps names unique case-insensitively and returns stable section ordering", async () => {
    const documents = await store.createSection("Documents");
    const dnc = await store.createSection("DNC");
    await database
      .update(schema.botSections)
      .set({ createdAt: new Date("2026-11-02T12:00:00.000Z") })
      .where(eq(schema.botSections.id, documents.id));
    await database
      .update(schema.botSections)
      .set({ createdAt: new Date("2026-11-02T12:01:00.000Z") })
      .where(eq(schema.botSections.id, dnc.id));
    await store.setBotSection("beta", dnc.id);
    await store.setBotSection("alpha", documents.id);

    await expect(store.createSection("documents")).rejects.toThrow(
      "already exists"
    );
    await expect(store.listSections()).resolves.toEqual([
      { botSlugs: ["alpha"], id: documents.id, name: "Documents" },
      { botSlugs: ["beta"], id: dnc.id, name: "DNC" },
    ]);
  });

  it("moves one bot atomically, clears membership, and preserves the bot", async () => {
    const first = await store.createSection("First");
    const second = await store.createSection("Second");

    await store.setBotSection("alpha", first.id);
    await store.setBotSection("alpha", second.id);
    expect(await database.select().from(schema.botSectionMemberships)).toEqual([
      { botId: alphaId, sectionId: second.id },
    ]);

    await store.setBotSection("alpha", null);
    expect(await database.select().from(schema.botSectionMemberships)).toEqual(
      []
    );
    expect(
      await database
        .select({ id: schema.bots.id, slug: schema.bots.slug })
        .from(schema.bots)
    ).toHaveLength(2);
  });

  it("returns typed not-found errors and cascades only memberships on section deletion", async () => {
    const section = await store.createSection("Documents");
    await store.setBotSection("alpha", section.id);

    await expect(store.setBotSection("missing", section.id)).rejects.toThrow(
      "Bot not found"
    );
    await expect(
      store.setBotSection("alpha", "33333333-3333-4333-8333-333333333333")
    ).rejects.toThrow("Section not found");

    await store.deleteSection(section.id);
    expect(await database.select().from(schema.botSectionMemberships)).toEqual(
      []
    );
    expect(
      await database
        .select({ id: schema.bots.id, slug: schema.bots.slug })
        .from(schema.bots)
    ).toHaveLength(2);
  });

  it("keeps the tables private to the hub connection", async () => {
    const rls = await client.query<{ table_name: string; enabled: boolean }>(`
      SELECT relname AS table_name, relrowsecurity AS enabled
      FROM pg_class
      WHERE relname IN ('bot_sections', 'bot_section_memberships')
      ORDER BY relname
    `);
    expect(rls.rows).toEqual([
      { enabled: true, table_name: "bot_section_memberships" },
      { enabled: true, table_name: "bot_sections" },
    ]);

    const grants = await client.query<{
      table_name: string;
      privilege_type: string;
    }>(`
      SELECT table_name, privilege_type
      FROM information_schema.role_table_grants
      WHERE grantee IN ('anon', 'authenticated')
        AND table_name IN ('bot_sections', 'bot_section_memberships')
    `);
    expect(grants.rows).toEqual([]);
    const privileges = await client.query<{
      sections: boolean;
      memberships: boolean;
    }>(`
      SELECT
        has_table_privilege('anon', 'public.bot_sections', 'SELECT') AS sections,
        has_table_privilege('authenticated', 'public.bot_section_memberships', 'SELECT') AS memberships
    `);
    expect(privileges.rows[0]).toEqual({ memberships: false, sections: false });
  });

  it("cascades a deleted bot's membership while retaining its sections", async () => {
    const section = await store.createSection("Documents");
    await store.setBotSection("alpha", section.id);

    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}';`);

    expect(await database.select().from(schema.botSectionMemberships)).toEqual(
      []
    );
    await expect(store.listSections()).resolves.toEqual([
      { botSlugs: [], id: section.id, name: "Documents" },
    ]);
  });

  it("keeps the old assignment when a move fails and rejects duplicate renames", async () => {
    const first = await store.createSection("First");
    const second = await store.createSection("Second");
    await store.setBotSection("alpha", first.id);

    await expect(
      store.setBotSection("alpha", "33333333-3333-4333-8333-333333333333")
    ).rejects.toThrow("Section not found");
    const afterFailedMove = await store.listSections();
    expect(afterFailedMove).toHaveLength(2);
    expect(afterFailedMove).toEqual(
      expect.arrayContaining([
        { botSlugs: ["alpha"], id: first.id, name: "First" },
        { botSlugs: [], id: second.id, name: "Second" },
      ])
    );

    await expect(store.updateSection(second.id, "first")).rejects.toThrow(
      "already exists"
    );
    const afterDuplicateRename = await store.listSections();
    expect(afterDuplicateRename).toHaveLength(2);
    expect(afterDuplicateRename).toEqual(
      expect.arrayContaining([
        { botSlugs: ["alpha"], id: first.id, name: "First" },
        { botSlugs: [], id: second.id, name: "Second" },
      ])
    );
  });

  it("can safely reapply its additive migration", async () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL("./drizzle/0014_bot_sections.sql", import.meta.url)
      ),
      "utf8"
    );
    const section = await store.createSection("Documents");
    await store.setBotSection("beta", section.id);

    await expect(client.exec(migration)).resolves.toBeDefined();
    await expect(store.listSections()).resolves.toEqual([
      { botSlugs: ["beta"], id: section.id, name: "Documents" },
    ]);
  });
});
