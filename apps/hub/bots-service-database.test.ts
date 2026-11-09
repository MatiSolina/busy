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
import { bots } from "./lib/db/schema";

const INSERT_BOT = /^insert into "bots"/iu;
const DNS_LABEL = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

let client: PGlite;
let database: BotsDatabase;

vi.mock("./lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/db")>()),
  db: () => database,
}));

const service = await import("./lib/bots/service");

const input = (name: string) => ({
  avatar: null,
  billing: "gateway" as const,
  description: "Reviews contracts.",
  fast: false,
  instructions: "",
  model: "moonshotai/kimi-k3",
  name,
});

/** Holds the first `count` bot inserts until all of them were issued: both creates read the same slugs. */
function holdInserts(count: number) {
  const original = client.query.bind(client);
  let waiting = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi
    .spyOn(client, "query")
    .mockImplementation(async (...args: Parameters<PGlite["query"]>) => {
      if (INSERT_BOT.test(args[0]) && waiting < count) {
        waiting += 1;
        if (waiting === count) {
          release();
        }
        await gate;
      }
      return await original(...args);
    });
  return spy;
}

beforeAll(async () => {
  ({ client, database } = await botsDatabase());
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await client.exec("DELETE FROM bots");
});

afterAll(async () => {
  await client.close();
});

describe("insertBot slug collisions (H-30)", () => {
  it("two interleaved creates with the same name get slug and slug-2", async () => {
    holdInserts(2);
    const rows = await Promise.all([
      service.insertBot(input("Contract Desk")),
      service.insertBot(input("Contract Desk")),
    ]);
    expect(rows.map((r) => r.slug).sort()).toEqual([
      "contract-desk",
      "contract-desk-2",
    ]);
    expect(console.warn).toHaveBeenCalledWith("bot slug collision", {
      attempt: 1,
    });
  });

  it("answers a domain conflict after the bounded attempts, never a duplicate row", async () => {
    // Every candidate taken between the read and the insert: simulate by pre-taking them all.
    const values = ["contract-desk", 2, 3, 4, 5, 6].map((n) => ({
      ...input("Contract Desk"),
      slug: typeof n === "string" ? n : `contract-desk-${n}`,
    }));
    await database.insert(bots).values(values[0]);
    // Each read sees only the base slug; the insert then finds the next one already taken.
    let next = 1;
    const original = client.query.bind(client);
    vi.spyOn(client, "query").mockImplementation(
      async (...args: Parameters<PGlite["query"]>) => {
        const row = values[next];
        if (INSERT_BOT.test(args[0]) && row) {
          next += 1;
          await original(
            "INSERT INTO bots (slug, name, description) VALUES ($1, $2, $3)",
            [row.slug, row.name, row.description]
          );
        }
        return await original(...args);
      }
    );
    await expect(service.insertBot(input("Contract Desk"))).rejects.toThrow(
      service.SlugConflictError
    );
    const count = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n, count(DISTINCT slug)::int AS d FROM bots"
    );
    expect(count.rows[0]).toEqual({ d: 6, n: 6 });
  });

  it("does not swallow a unique violation of another constraint", async () => {
    await client.exec(
      "CREATE UNIQUE INDEX bots_description_test ON bots (description)"
    );
    try {
      await service.insertBot(input("Alpha"));
      await expect(service.insertBot(input("Beta"))).rejects.toMatchObject({
        cause: expect.objectContaining({ code: "23505" }),
      });
    } finally {
      await client.exec("DROP INDEX bots_description_test");
    }
  });

  it("keeps a 40-character base DNS-safe and unique when suffixed", async () => {
    const name = `${"a".repeat(39)}b-c`;
    const first = await service.insertBot(input(name));
    const second = await service.insertBot(input(name));
    expect(first.slug).toHaveLength(40);
    expect(second.slug.length).toBeLessThanOrEqual(40);
    expect(second.slug).toMatch(DNS_LABEL);
    expect(second.slug).not.toBe(first.slug);
  });
});
