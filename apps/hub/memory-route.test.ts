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
import { memories } from "@/lib/db/schema";

const BOT = "assistant";
let client: PGlite;
let database: ReturnType<typeof drizzle<{ memories: typeof memories }>>;
let route: typeof import("@/app/api/bots/[slug]/memory/route");

beforeAll(async () => {
  process.env.SESSION_SECRET = "test-secret";
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Assistant'
    );
    CREATE TABLE memories (
      bot_slug text PRIMARY KEY,
      content text NOT NULL,
      version integer NOT NULL
    );
    INSERT INTO bots (id, slug) VALUES
      ('11111111-1111-4111-8111-111111111111', '${BOT}');
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0017_memory_metadata.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema: { memories } });
  vi.doMock("next/headers", () => ({
    cookies: async () => ({ get: () => ({ value: "session" }) }),
  }));
  vi.doMock("@/lib/auth/session", () => ({
    readSession: vi.fn().mockResolvedValue({ user: "mati" }),
    SESSION_COOKIE: "busy_session",
  }));
  vi.doMock("@/lib/bots/service", () => ({
    getBot: vi.fn().mockResolvedValue({ slug: BOT }),
  }));
  vi.doMock("@/lib/db", () => ({ db: () => database, memories }));
  vi.resetModules();
  route = await import("@/app/api/bots/[slug]/memory/route");
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM memory_metadata_events; DELETE FROM memory_metadata; DELETE FROM memories;"
  );
});

afterAll(async () => {
  await client.close();
});

const params = { params: Promise.resolve({ slug: BOT }) };

describe("editable memory routes", () => {
  it("adds, searches, edits, and deletes against the versioned Eve document", async () => {
    const added = await route.POST(
      new Request("https://busy.test/api/bots/assistant/memory", {
        body: JSON.stringify({ expectedVersion: null, text: "Prefers Excel" }),
        method: "POST",
      }),
      params
    );
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({
      entries: [
        { author: "mati", id: "0", origin: "owner", text: "Prefers Excel" },
      ],
      version: 1,
    });

    const searched = await route.GET(
      new Request("https://busy.test/api/bots/assistant/memory?q=excel"),
      params
    );
    expect((await searched.json()).entries).toHaveLength(1);

    const edited = await route.PATCH(
      new Request("https://busy.test/api/bots/assistant/memory", {
        body: JSON.stringify({
          entryId: "0",
          expectedVersion: 1,
          text: "Prefers Google Sheets",
        }),
        method: "PATCH",
      }),
      params
    );
    expect((await edited.json()).entries[0].text).toBe("Prefers Google Sheets");

    const deleted = await route.DELETE(
      new Request("https://busy.test/api/bots/assistant/memory", {
        body: JSON.stringify({ entryId: "0", expectedVersion: 2 }),
        method: "DELETE",
      }),
      params
    );
    expect(await deleted.json()).toMatchObject({ entries: [], version: 3 });
  });

  it("rejects a stale browser write without clobbering the document", async () => {
    await route.POST(
      new Request("https://busy.test/api/bots/assistant/memory", {
        body: JSON.stringify({ expectedVersion: null, text: "One" }),
        method: "POST",
      }),
      params
    );
    const stale = await route.PATCH(
      new Request("https://busy.test/api/bots/assistant/memory", {
        body: JSON.stringify({
          entryId: "0",
          expectedVersion: 0,
          text: "Wrong",
        }),
        method: "PATCH",
      }),
      params
    );
    expect(stale.status).toBe(409);
    const current = await route.GET(
      new Request("https://busy.test/api/bots/assistant/memory"),
      params
    );
    expect((await current.json()).entries[0].text).toBe("One");
  });
});
