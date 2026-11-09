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
import { decryptOAuth } from "./lib/mcp/crypto";

const secret = "provider-database-test-secret-long-enough";
const alphaId = "11111111-1111-4111-8111-111111111111";
const betaId = "22222222-2222-4222-8222-222222222222";
const githubId = "33333333-3333-4333-8333-333333333333";
const googleId = "44444444-4444-4444-8444-444444444444";
const linearId = "55555555-5555-4555-8555-555555555555";

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let providerStore: typeof import("./lib/mcp/provider-clients");

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
      fileURLToPath(
        new URL("./drizzle/0009_mcp_provider_clients.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });

  vi.doMock("@/lib/db", () => ({
    db: () => database,
    mcpConnections: schema.mcpConnections,
    mcpProviderClients: schema.mcpProviderClients,
  }));
  vi.doMock("@/lib/env", () => ({
    need: (key: string) =>
      key === "HUB_URL" ? "https://busy.example.com" : secret,
  }));
  vi.doMock("@/lib/mcp/catalog", () => ({
    MCP_CATALOG: [
      { id: "github", oauthProvider: "github" },
      { id: "google", oauthProvider: "google" },
      { id: "linear" },
    ],
  }));
  vi.resetModules();
  providerStore = await import("./lib/mcp/provider-clients");
});

afterAll(async () => {
  await client.close();
});

// biome-ignore lint/style/useTestHooksInOrder: database setup runs before teardown while keeping the fixture lifecycle grouped.
beforeEach(async () => {
  await client.exec(
    "DELETE FROM mcp_provider_clients; DELETE FROM mcp_connections; DELETE FROM bots;"
  );
  await client.exec(`
    INSERT INTO bots (id, slug) VALUES
      ('${alphaId}', 'alpha'),
      ('${betaId}', 'beta');
  `);
});

async function insertConnection(id: string, botId: string, catalogId: string) {
  await database.insert(schema.mcpConnections).values({
    botId,
    catalogId,
    id,
    oauthData: `sealed-${catalogId}`,
    status: "connected",
  });
}

describe("registered provider database invariants", () => {
  it("applies migration 0009 with RLS, provider check and advisory locks available", async () => {
    const table = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(
      "select relname, relrowsecurity from pg_class where relname='mcp_provider_clients'"
    );
    expect(table.rows[0]).toMatchObject({
      relname: "mcp_provider_clients",
      relrowsecurity: true,
    });
    await client.exec(
      "select pg_advisory_xact_lock(hashtext('provider-database-test'))"
    );
    await expect(
      client.exec(
        "insert into mcp_provider_clients(provider,sealed_client) values ('invalid','sealed')"
      )
    ).rejects.toThrow();
  });

  it("saves encrypted credentials, returns the same revision for a blank edit, and decrypts by AAD", async () => {
    const first = await providerStore.saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    const [raw] = await database.select().from(schema.mcpProviderClients);
    expect(raw?.sealedClient).toBeTruthy();
    assert(raw?.sealedClient);
    expect(raw?.sealedClient).not.toContain("github-secret");
    expect(decryptOAuth(raw.sealedClient, "provider:github", secret)).toEqual({
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    await expect(
      providerStore.getProviderClient("github")
    ).resolves.toMatchObject({
      clientId: "github-client",
      clientSecret: "github-secret",
      version: first.version,
    });

    const same = await providerStore.saveProviderClient("github", {
      clientId: "github-client",
    });
    expect(same).toEqual({ changed: false, version: first.version });
  });

  it("invalidates only the matching registered provider rows and preserves DCR rows", async () => {
    await insertConnection(githubId, alphaId, "github");
    await insertConnection(googleId, alphaId, "google");
    await insertConnection(linearId, betaId, "linear");

    await providerStore.saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    let rows = await database.select().from(schema.mcpConnections);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: "Provider credentials changed. Reconnect this MCP.",
          id: githubId,
          oauthData: null,
          status: "error",
        }),
        expect.objectContaining({
          id: googleId,
          oauthData: "sealed-google",
          status: "connected",
        }),
        expect.objectContaining({
          id: linearId,
          oauthData: "sealed-linear",
          status: "connected",
        }),
      ])
    );

    await providerStore.saveProviderClient("google", {
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    rows = await database.select().from(schema.mcpConnections);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: githubId,
          oauthData: null,
          status: "error",
        }),
        expect.objectContaining({
          id: googleId,
          oauthData: null,
          status: "error",
        }),
        expect.objectContaining({
          id: linearId,
          oauthData: "sealed-linear",
          status: "connected",
        }),
      ])
    );
  });
});
