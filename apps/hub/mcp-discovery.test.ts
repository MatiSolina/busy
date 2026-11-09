import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverConnectionTools } from "./lib/mcp/discovery";

const mocks = vi.hoisted(() => ({
  client: {
    close: vi.fn(),
    listTools: vi.fn(),
  },
  createMCPClient: vi.fn(),
  freshRegisteredToken: vi.fn(),
  freshToken: vi.fn(),
  getProviderClient: vi.fn(),
  listConnections: vi.fn(),
  publicConnection: vi.fn((value: Record<string, unknown>) => ({
    catalogId: value.catalogId,
    error: value.error ?? null,
    id: value.id,
    status: value.status,
  })),
  withConnection: vi.fn(),
}));

vi.mock("@ai-sdk/mcp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ai-sdk/mcp")>()),
  createMCPClient: mocks.createMCPClient,
}));
vi.mock("./lib/mcp/network", () => ({
  assertPublicHttpUrl: vi
    .fn()
    .mockResolvedValue(new URL("https://example.com")),
  guardedFetch: fetch,
}));
vi.mock("./lib/mcp/oauth", () => ({
  freshToken: mocks.freshToken,
  McpOAuthProvider: class {
    data: Record<string, unknown>;
    constructor(data: Record<string, unknown>) {
      this.data = data;
    }
  },
}));
vi.mock("./lib/mcp/provider-clients", () => ({
  getProviderClient: mocks.getProviderClient,
}));
vi.mock("./lib/mcp/registered-oauth", () => ({
  freshRegisteredToken: mocks.freshRegisteredToken,
}));
vi.mock("./lib/mcp/store", () => ({
  listConnections: mocks.listConnections,
  publicConnection: mocks.publicConnection,
  withConnection: mocks.withConnection,
}));

const row = {
  catalogId: "context7",
  error: null,
  id: "connection-1",
  oauthData: null,
  status: "connected" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listConnections.mockResolvedValue([row]);
  mocks.createMCPClient.mockResolvedValue(mocks.client);
  mocks.client.listTools.mockResolvedValue({
    tools: [
      {
        annotations: { readOnlyHint: true },
        description: "Read docs",
        name: "read_docs",
      },
      {
        annotations: { destructiveHint: true },
        description: "Delete docs",
        name: "delete_docs",
      },
    ],
  });
  mocks.withConnection.mockImplementation(
    async (
      _id: string,
      callback: (
        selected: typeof row,
        data: Record<string, unknown>
      ) => Promise<{ value: unknown }>
    ) => (await callback(row, {})).value
  );
});

describe("MCP tool discovery", () => {
  it("discovers on the server and defaults to read-only tools", async () => {
    const result = await discoverConnectionTools(row.id);
    expect(result).toMatchObject({
      allowedTools: ["read_docs"],
      catalogId: "context7",
      tools: [
        { name: "read_docs", readOnlyHint: true },
        { destructiveHint: true, name: "delete_docs" },
      ],
    });
    expect(mocks.createMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
        transport: expect.objectContaining({
          type: "http",
          url: "https://mcp.context7.com/mcp",
        }),
      })
    );
    expect(mocks.client.close).toHaveBeenCalledOnce();
  });

  it("does not put credentials in the returned discovery snapshot", async () => {
    const result = await discoverConnectionTools(row.id);
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("retains app-only tools for permission review without losing their visibility", async () => {
    mocks.client.listTools.mockResolvedValue({
      tools: [
        {
          _meta: {
            private: "not retained",
            ui: {
              resourceUri: "ui://deployments/card",
              visibility: ["model", "app"],
            },
          },
          annotations: { readOnlyHint: true },
          name: "open_deployments",
        },
        {
          _meta: { ui: { visibility: ["app"] } },
          annotations: { readOnlyHint: true },
          name: "refresh_deployments",
        },
      ],
    });
    const result = await discoverConnectionTools(row.id);
    expect(result?.tools).toEqual([
      {
        description: "open_deployments",
        name: "open_deployments",
        readOnlyHint: true,
        ui: {
          resourceUri: "ui://deployments/card",
          visibility: ["model", "app"],
        },
      },
      {
        description: "refresh_deployments",
        name: "refresh_deployments",
        readOnlyHint: true,
        ui: { visibility: ["app"] },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("not retained");
  });
});
