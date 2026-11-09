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
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema namespace to the database client.
import * as schema from "./lib/db/schema";
import { decryptOAuth, encryptOAuth } from "./lib/mcp/crypto";

const secret = "pglite-mcp-test-secret-which-is-long-enough";
const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const linearId = "33333333-3333-4333-8333-333333333333";
const context7Id = "44444444-4444-4444-8444-444444444444";

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./lib/mcp/store");

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
        new URL("./drizzle/0008_mcp_marketplace.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(new URL("./drizzle/0013_app_mcp.sql", import.meta.url)),
      "utf8"
    )
  );
  database = drizzle(client, { schema });

  // The store's production db() is a lazy singleton. Inject this real PGlite
  // Drizzle instance only for this test module, while keeping its schema and
  // query builders untouched.
  vi.doMock("@/lib/db", () => ({
    db: () => database,
    mcpConnections: schema.mcpConnections,
  }));
  vi.doMock("@/lib/env", () => ({ need: () => secret }));
  vi.resetModules();
  store = await import("./lib/mcp/store");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database fixture lifecycle keeps setup and teardown grouped.
beforeEach(async () => {
  await client.exec("DELETE FROM mcp_connections; DELETE FROM bots;");
  await client.exec(`
    INSERT INTO bots (id, slug) VALUES
      ('${alphaId}', 'alpha'),
      ('${betaId}', 'beta');
  `);
});

async function insertConnection(
  id: string,
  botId: string,
  catalogId = "linear",
  status: "pending" | "connected" | "error" = "connected"
) {
  await database.insert(schema.mcpConnections).values({
    botId,
    catalogId,
    id,
    oauthData: encryptOAuth(
      {
        redirectOrigin: "https://busy.test",
        tokens: {
          access_token: "access-secret",
          expires_in: 3600,
          refresh_token: "refresh-secret",
        },
        tokensIssuedAt: Date.now(),
      },
      id,
      secret
    ),
    status,
  });
}

describe("MCP database invariants", () => {
  it("preserves app grants even when legacy bots had duplicate catalogue rows", async () => {
    await insertConnection(linearId, alphaId);
    await insertConnection(context7Id, alphaId, "linear");
    await insertConnection(betaId, betaId, "linear");
    const rows = await database.select().from(schema.mcpConnections);
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.botId).sort()).toEqual([
      alphaId,
      alphaId,
      betaId,
    ]);
  });

  it("keeps app grants when a legacy owning bot is deleted", async () => {
    await insertConnection(linearId, alphaId);
    await client.exec(`DELETE FROM bots WHERE id = '${alphaId}';`);
    const rows = await database.select().from(schema.mcpConnections);
    expect(rows).toHaveLength(1);
  });
});

describe("MCP app connection store", () => {
  it("removes a connection by id regardless of legacy bot provenance", async () => {
    await insertConnection(linearId, alphaId);
    await store.removeConnection(linearId);
    expect(await store.listConnections()).toHaveLength(0);
  });

  it("locks and updates the app connection's encrypted row", async () => {
    await insertConnection(linearId, alphaId);
    const callback = vi.fn();
    // biome-ignore lint/suspicious/noShadow: callback parameter intentionally names the domain row being tested.
    // biome-ignore lint/suspicious/useAwait: test double intentionally preserves the Promise-returning API contract.
    const result = await store.withConnection(linearId, async (row, data) => {
      expect(row.botId).toBe(alphaId);
      expect(data.tokens?.access_token).toBe("access-secret");
      assert(data.tokens);
      return {
        data: {
          ...data,
          tokens: { ...data.tokens, access_token: "rotated-access" },
        },
        error: null,
        status: "connected" as const,
        value: "updated",
      };
    });
    expect(result).toBe("updated");
    expect(callback).not.toHaveBeenCalled();

    const [row] = await database.select().from(schema.mcpConnections);
    assert(row);
    assert(row.oauthData);
    const decrypted = decryptOAuth<{ tokens: { access_token: string } }>(
      row.oauthData,
      linearId,
      secret
    );
    expect(decrypted.tokens.access_token).toBe("rotated-access");
    expect(row.oauthData).not.toContain("rotated-access");
  });
});
