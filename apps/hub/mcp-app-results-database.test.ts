import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mcpAppResults } from "./lib/db/schema";

const botId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const sessionId = "session-main";
const scope = { botId, callId: "call-1", connectionId, sessionId };
let client: PGlite;
let results: typeof import("./lib/mcp/app-results");

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (id uuid PRIMARY KEY);
    CREATE TABLE mcp_connections (id uuid PRIMARY KEY);
    INSERT INTO bots VALUES ('${botId}');
    INSERT INTO mcp_connections VALUES ('${connectionId}');
  `);
  await client.exec(
    readFileSync(
      new URL("./drizzle/0022_mcp_app_results.sql", import.meta.url),
      "utf8"
    )
  );
  const database = drizzle(client);
  vi.doMock("@/lib/db", () => ({ db: () => database, mcpAppResults }));
  vi.doMock("@/lib/env", () => ({
    need: () => "synthetic-mcp-app-result-secret-1234",
  }));
  results = await import("./lib/mcp/app-results");
});

afterAll(async () => {
  await client.close();
});

describe("private MCP App result snapshots", () => {
  it("preserves private result metadata, encrypted and restricted to its originating scope", async () => {
    const snapshot = {
      ...scope,
      input: { project: "demo" },
      result: {
        _meta: { privateAppData: "synthetic-private-app-value" },
        content: [{ text: "Deployment ready", type: "text" }],
      },
      toolName: "open_deployments",
    };
    const id = await results.saveMcpAppResult(snapshot);
    expect(await results.getMcpAppResult(id, scope)).toEqual(snapshot);
    expect(
      await results.getMcpAppResultForCall(id, {
        botId,
        callId: scope.callId,
        sessionId,
      })
    ).toEqual(snapshot);
    expect(await results.findMcpAppResult(scope)).toEqual({ id, snapshot });
    expect(
      await results.getMcpAppResult(id, { ...scope, callId: "call-2" })
    ).toBeNull();
    expect(
      await results.getMcpAppResult(id, {
        ...scope,
        sessionId: "another-session",
      })
    ).toBeNull();
    expect(
      await results.getMcpAppResult(id, { ...scope, botId: connectionId })
    ).toBeNull();
    expect(
      await results.getMcpAppResult(id, { ...scope, connectionId: botId })
    ).toBeNull();
    const stored = await client.query<{ sealed_result: string }>(
      "SELECT sealed_result FROM mcp_app_results WHERE id = $1",
      [id]
    );
    expect(stored.rows[0]?.sealed_result).not.toContain(
      "synthetic-private-app-value"
    );
  });

  it("enables RLS and grants no browser roles direct access", async () => {
    const result = await client.query<{
      rls: boolean;
      anon_read: boolean;
      authenticated_read: boolean;
    }>(`
      SELECT relrowsecurity AS rls,
        has_table_privilege('anon', 'mcp_app_results', 'SELECT') AS anon_read,
        has_table_privilege('authenticated', 'mcp_app_results', 'SELECT') AS authenticated_read
      FROM pg_class WHERE relname = 'mcp_app_results'
    `);
    expect(result.rows).toEqual([
      { anon_read: false, authenticated_read: false, rls: true },
    ]);
  });

  it("authenticates the stored tool and provenance alongside the encrypted result", async () => {
    const context = { ...scope, callId: "call-tampered" };
    const id = await results.saveMcpAppResult({
      ...context,
      input: {},
      result: { content: [] },
      toolName: "open_deployments",
    });
    await client.query(
      "UPDATE mcp_app_results SET tool_name = 'another_tool' WHERE id = $1",
      [id]
    );
    await expect(results.getMcpAppResult(id, context)).rejects.toThrow(
      "Invalid sealed MCP OAuth payload"
    );
  });
});
