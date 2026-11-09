import assert from "node:assert/strict";
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
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";

const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const firstId = "33333333-3333-4333-8333-333333333333";
const tieId = "44444444-4444-4444-8444-444444444444";
const olderId = "55555555-5555-4555-8555-555555555555";

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let library: typeof import("./lib/library");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Bot',
      avatar text,
      description text NOT NULL DEFAULT '',
      instructions text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT 'model/example',
      billing text NOT NULL DEFAULT 'gateway',
      fast boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'ready',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      name text NOT NULL,
      pathname text NOT NULL,
      content_type text NOT NULL,
      size integer NOT NULL,
      version integer NOT NULL,
      source text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({
    bots: schema.bots,
    db: () => database,
    files: schema.files,
  }));
  vi.resetModules();
  library = await import("./lib/library");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  await client.exec("DELETE FROM files; DELETE FROM bots;");
  await client.exec(`
    INSERT INTO bots (id, slug, name, avatar) VALUES
      ('${alphaId}', 'alpha', 'Alpha', 'A'),
      ('${betaId}', 'beta', 'Beta', 'B');

    INSERT INTO files (id, bot_id, name, pathname, content_type, size, version, source, status, created_at) VALUES
      ('${firstId}', '${alphaId}', '100% plan.pdf', 'bots/alpha/1-100% plan.pdf', 'application/pdf', 10, 1, 'bot', 'ready', '2026-11-02 12:00:00.123456+00'),
      ('${tieId}', '${alphaId}', 'tie.pdf', 'bots/alpha/2-tie.pdf', 'application/pdf', 20, 2, 'bot', 'ready', '2026-11-02 12:00:00.123456+00'),
      ('${olderId}', '${betaId}', 'xplan.pdf', 'bots/beta/1-xplan.pdf', 'application/pdf', 30, 1, 'bot', 'ready', '2026-11-02 11:59:59.999999+00'),
      ('66666666-6666-4666-8666-666666666666', '${alphaId}', 'pending.pdf', 'bots/alpha/3-pending.pdf', 'application/pdf', 40, 3, 'bot', 'pending', '2026-11-02 12:00:02.000000+00'),
      ('77777777-7777-4777-8777-777777777777', '${alphaId}', 'user.pdf', 'bots/alpha/4-user.pdf', 'application/pdf', 50, 4, 'user', 'ready', '2026-11-02 12:00:03.000000+00');
  `);
});

describe("library query against Postgres semantics", () => {
  it("filters ready bot files, preserves microsecond cursor ties, and treats wildcard search literally", async () => {
    const parsed = library.parseLibraryQuery(new URLSearchParams("limit=1"));
    assert(parsed);
    const first = await library.listLibraryFiles(parsed);
    expect(first.files.map((file) => file.id)).toEqual([tieId]);
    expect(first.nextCursor).toBeTruthy();

    const second = await library.listLibraryFiles({
      ...parsed,
      cursor: library.decodeLibraryCursor(first.nextCursor),
    });
    expect(second.files.map((file) => file.id)).toEqual([firstId]);

    const third = await library.listLibraryFiles({
      ...parsed,
      cursor: library.decodeLibraryCursor(second.nextCursor),
    });
    expect(third.files.map((file) => file.id)).toEqual([olderId]);

    const literal = await library.listLibraryFiles({
      ...parsed,
      cursor: null,
      limit: 48,
      search: "%",
    });
    expect(literal.files.map((file) => file.name)).toEqual(["100% plan.pdf"]);
  });

  it("applies bot and category filters in the database query", async () => {
    const parsed = library.parseLibraryQuery(
      new URLSearchParams("bot=beta&type=document&limit=48")
    );
    assert(parsed);
    const result = await library.listLibraryFiles(parsed);
    expect(result.files.map((file) => file.id)).toEqual([olderId]);
    expect(result.files[0]?.bot).toMatchObject({ name: "Beta", slug: "beta" });
  });
});
