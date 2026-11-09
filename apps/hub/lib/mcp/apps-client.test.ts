import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows: unknown[] = [];
  const client = {
    callTool: vi.fn(),
    close: vi.fn(),
    listTools: vi.fn(),
  };
  const data = {} as Record<string, unknown>;
  class OAuthProvider {
    data: Record<string, unknown>;

    constructor(value: Record<string, unknown>) {
      this.data = { ...value };
    }

    invalidateCredentials(scope: string) {
      if (scope === "tokens") {
        this.data.tokens = undefined;
      }
    }
  }
  return {
    client,
    connectionRuntimeState: vi.fn(),
    createMCPClient: vi.fn(),
    data,
    db: vi.fn(() => ({
      select: () => {
        const builder = {
          from: () => builder,
          limit: () => {
            const row = rows.shift();
            return row === undefined ? [] : [row];
          },
          orderBy: () => builder,
          where: () => builder,
        };
        return builder;
      },
    })),
    freshToken: vi.fn(),
    getBot: vi.fn(),
    getMcpAppResultForCall: vi.fn(),
    getProviderClient: vi.fn(),
    listConnections: vi.fn(),
    OAuthProvider,
    ReconnectError: class extends Error {},
    readMCPAppResource: vi.fn(),
    rows,
    withConnection: vi.fn(),
  };
});

vi.mock("@ai-sdk/mcp", () => ({
  createMCPClient: mocks.createMCPClient,
  mcpAppClientCapabilities: { extensions: {} },
  readMCPAppResource: mocks.readMCPAppResource,
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  asc: vi.fn(),
  eq: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/db", () => ({
  db: mocks.db,
  events: {
    data: "data",
    index: "index",
    line: "line",
    sessionId: "sessionId",
    type: "type",
  },
}));
vi.mock("@/lib/mcp/app-results", () => ({
  getMcpAppResultForCall: mocks.getMcpAppResultForCall,
}));
vi.mock("@/lib/mcp/network", () => ({
  assertPublicHttpUrl: vi.fn(),
  guardedFetch: fetch,
}));
vi.mock("@/lib/mcp/oauth", () => ({
  freshToken: mocks.freshToken,
  McpOAuthProvider: mocks.OAuthProvider,
  McpReconnectError: mocks.ReconnectError,
}));
vi.mock("@/lib/mcp/provider-clients", () => ({
  getProviderClient: mocks.getProviderClient,
}));
vi.mock("@/lib/mcp/registered-oauth", () => ({
  freshRegisteredToken: vi.fn(),
}));
vi.mock("@/lib/mcp/store", () => ({
  connectionRuntimeState: mocks.connectionRuntimeState,
  listConnections: mocks.listConnections,
  withConnection: mocks.withConnection,
}));

const { callMcpAppTool, readMcpAppResource, withMcpConnectionClient } =
  await import("./apps-client");

const connection = {
  catalogId: "context7",
  id: "11111111-1111-4111-8111-111111111111",
  oauthData: null,
  status: "connected" as const,
};
const oauthConnection = {
  catalogId: "linear",
  id: "44444444-4444-4444-8444-444444444444",
  oauthData: "sealed",
  status: "connected" as const,
};
const bot = {
  id: "22222222-2222-4222-8222-222222222222",
  sessionId: "wrun_current",
};

function requestRow(toolName = "mcp_context7__read_docs") {
  return {
    data: {
      data: {
        callId: "call-1",
        capability: { name: toolName },
        input: { query: "MCP Apps" },
      },
      type: "call.requested",
    },
    index: 0,
    line: 1,
  };
}

function settledRow() {
  return {
    data: {
      data: {
        callId: "call-1",
        output: {
          _busyMcpApp: { snapshotId: "33333333-3333-4333-8333-333333333333" },
        },
      },
      type: "call.settled",
    },
    index: 0,
    line: 2,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(mocks.data)) {
    delete mocks.data[key];
  }
  vi.stubEnv("NODE_ENV", "test");
  process.env.HUB_URL = "http://localhost:3000";
  process.env.MCP_APP_SANDBOX_ORIGIN = "http://127.0.0.1:3000";
  process.env.SESSION_SECRET = "test-secret-for-mcp-app-approvals";
  mocks.getBot.mockResolvedValue(bot);
  mocks.listConnections.mockResolvedValue([connection]);
  mocks.connectionRuntimeState.mockResolvedValue({
    aclMode: "enforced",
    allowedTools: ["read_docs", "send_message"],
    lifecycle: "active",
    reauthRequired: false,
    tools: [],
  });
  mocks.getMcpAppResultForCall.mockResolvedValue({
    botId: bot.id,
    connectionId: connection.id,
    input: { query: "MCP Apps" },
    result: { text: "answer" },
    sessionId: bot.sessionId,
    toolName: "read_docs",
  });
  mocks.rows.splice(0, mocks.rows.length, requestRow(), settledRow());
  mocks.withConnection.mockImplementation(
    async (
      _id: string,
      run: (
        row: typeof connection,
        data: Record<string, unknown>
      ) => Promise<{ data: Record<string, unknown>; value: unknown }>
    ) => (await run(connection, mocks.data)).value
  );
  mocks.createMCPClient.mockResolvedValue(mocks.client);
  mocks.client.close.mockResolvedValue(undefined);
  mocks.readMCPAppResource.mockResolvedValue({
    html: "<html></html>",
    mimeType: "text/html;profile=mcp-app",
    uri: "ui://docs/card",
  });
  mocks.client.listTools.mockResolvedValue({
    tools: [
      {
        _meta: {
          ui: { resourceUri: "ui://docs/card", visibility: ["model", "app"] },
        },
        annotations: { readOnlyHint: true },
        description: "Read docs",
        name: "read_docs",
      },
    ],
  });
  mocks.client.callTool.mockResolvedValue({
    content: [{ text: "ok", type: "text" }],
  });
});

describe("MCP Apps server client", () => {
  it("returns a retryable not-found while the streamed result is still being saved", async () => {
    mocks.rows.splice(0, mocks.rows.length, requestRow());
    await expect(readMcpAppResource("alpha", "call-1")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });
  it("binds a resource to the current bot session and encrypted result snapshot", async () => {
    mocks.listConnections.mockResolvedValue([
      connection,
      {
        ...connection,
        id: "55555555-5555-4555-8555-555555555555",
        status: "error",
      },
    ]);
    const response = await readMcpAppResource("alpha", "call-1");
    expect(response.app).toMatchObject({
      connectionId: connection.id,
      input: { query: "MCP Apps" },
      resourceUri: "ui://docs/card",
      result: { text: "answer" },
      toolName: "mcp_context7__read_docs",
    });
    expect(response.sandboxUrl).toBe("http://127.0.0.1:3000/mcp-app-sandbox");
    expect(mocks.getMcpAppResultForCall).toHaveBeenCalledWith(
      "33333333-3333-4333-8333-333333333333",
      expect.objectContaining({ botId: bot.id, sessionId: bot.sessionId })
    );
    expect(mocks.withConnection).toHaveBeenCalledWith(
      connection.id,
      expect.any(Function)
    );
  });

  it("consumes a write approval once and does not retry the remote call", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: { ui: { resourceUri: "ui://docs/card", visibility: ["app"] } },
          annotations: { readOnlyHint: false },
          description: "Send a message",
          name: "send_message",
        },
      ],
    });
    const first = callMcpAppTool("alpha", {
      arguments: { text: "hello" },
      callId: "call-1",
      name: "send_message",
    });
    await expect(first).rejects.toMatchObject({ code: "approval_required" });
    const approval = (await first.catch((error) =>
      String(error.approval)
    )) as string;
    mocks.rows.splice(0, mocks.rows.length, requestRow(), settledRow());
    await expect(
      callMcpAppTool("alpha", {
        approval,
        arguments: { text: "hello" },
        callId: "call-1",
        name: "send_message",
      })
    ).resolves.toMatchObject({ content: [{ text: "ok" }] });
    mocks.rows.splice(0, mocks.rows.length, requestRow(), settledRow());
    await expect(
      callMcpAppTool("alpha", {
        approval,
        arguments: { text: "hello" },
        callId: "call-1",
        name: "send_message",
      })
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(mocks.client.callTool).toHaveBeenCalledTimes(1);
  });

  it("rejects a snapshot whose provenance input does not match the launcher", async () => {
    mocks.getMcpAppResultForCall.mockResolvedValueOnce({
      botId: bot.id,
      callId: "call-1",
      connectionId: connection.id,
      input: { query: "different" },
      result: { text: "untrusted" },
      sessionId: bot.sessionId,
      toolName: "read_docs",
    });
    await expect(readMcpAppResource("alpha", "call-1")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it("rejects a revoked or differently scoped snapshot", async () => {
    mocks.getMcpAppResultForCall.mockResolvedValueOnce(null);
    await expect(readMcpAppResource("alpha", "call-1")).rejects.toMatchObject({
      code: "not_found",
    });
    expect(mocks.createMCPClient).not.toHaveBeenCalled();
  });

  it("rejects a previously issued approval after the tool descriptor changes", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: { ui: { resourceUri: "ui://docs/card", visibility: ["app"] } },
          annotations: { readOnlyHint: false },
          description: "Send a message",
          inputSchema: { properties: { text: { type: "string" } } },
          name: "send_message",
        },
      ],
    });
    const first = callMcpAppTool("alpha", {
      arguments: { text: "hello" },
      callId: "call-1",
      name: "send_message",
    });
    await expect(first).rejects.toMatchObject({ code: "approval_required" });
    const approval = (await first.catch((error) =>
      String(error.approval)
    )) as string;
    mocks.rows.splice(0, mocks.rows.length, requestRow(), settledRow());
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: { ui: { resourceUri: "ui://docs/card", visibility: ["app"] } },
          annotations: { destructiveHint: true, readOnlyHint: false },
          description: "Send a message",
          inputSchema: { properties: { text: { type: "string" } } },
          name: "send_message",
        },
      ],
    });
    await expect(
      callMcpAppTool("alpha", {
        approval,
        arguments: { text: "hello" },
        callId: "call-1",
        name: "send_message",
      })
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(mocks.client.callTool).not.toHaveBeenCalled();
  });

  it("does not proxy an app call for a model-only tool", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: {
            ui: { resourceUri: "ui://docs/card", visibility: ["model"] },
          },
          annotations: { readOnlyHint: true },
          description: "Read docs",
          name: "read_docs",
        },
      ],
    });
    await expect(
      callMcpAppTool("alpha", {
        arguments: { query: "MCP Apps" },
        callId: "call-1",
        name: "read_docs",
      })
    ).rejects.toMatchObject({ code: "tool_not_allowed" });
    expect(mocks.client.callTool).not.toHaveBeenCalled();
  });

  it("does not evict active approval receipts when the cap is full", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: { ui: { resourceUri: "ui://docs/card", visibility: ["app"] } },
          annotations: { readOnlyHint: false },
          description: "Send a message",
          name: "send_message",
        },
      ],
    });
    const first = callMcpAppTool("alpha", {
      arguments: { text: "hello" },
      callId: "call-1",
      name: "send_message",
    });
    await expect(first).rejects.toMatchObject({ code: "approval_required" });
    const approval = (await first.catch((error) =>
      String(error.approval)
    )) as string;
    mocks.data.busyMcpAppApprovals = Array.from(
      { length: 100 },
      (_, index) => ({
        consumedAt: Date.now(),
        tokenHash: `active-${index}`,
      })
    );
    mocks.rows.splice(0, mocks.rows.length, requestRow(), settledRow());
    await expect(
      callMcpAppTool("alpha", {
        approval,
        arguments: { text: "hello" },
        callId: "call-1",
        name: "send_message",
      })
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(mocks.client.callTool).not.toHaveBeenCalled();
  });

  it("persists a rotated OAuth token when client initialization fails", async () => {
    mocks.listConnections.mockResolvedValue([oauthConnection]);
    mocks.connectionRuntimeState.mockResolvedValue({
      aclMode: "enforced",
      allowedTools: ["read_issue"],
      catalogHash: "catalog-hash",
      catalogVersion: "catalog-version",
      lifecycle: "active",
      reauthRequired: false,
      tools: [],
    });
    mocks.withConnection.mockImplementation(
      async (
        _id: string,
        run: (
          row: typeof oauthConnection,
          data: Record<string, unknown>
        ) => Promise<{ data: Record<string, unknown>; value: unknown }>
      ) => run(oauthConnection, mocks.data).then((result) => result.value)
    );
    mocks.data.redirectOrigin = "https://busy.example.com";
    mocks.data.tokens = {
      access_token: "old",
      expires_in: 1,
      refresh_token: "refresh",
      token_type: "Bearer",
    };
    mocks.freshToken.mockImplementation(
      (provider: { data: Record<string, unknown> }) => {
        provider.data.tokens = {
          access_token: "rotated",
          expires_in: 3600,
          refresh_token: "refresh-2",
          token_type: "Bearer",
        };
        return { expiresAt: Date.now() + 3_600_000, token: "rotated" };
      }
    );
    mocks.createMCPClient.mockRejectedValueOnce(new Error("initialize failed"));
    await expect(
      withMcpConnectionClient(oauthConnection.id, async () => undefined)
    ).rejects.toThrow("initialize failed");
    expect(mocks.data.tokens).toMatchObject({ access_token: "rotated" });
  });
});
