import { createMCPClient } from "@ai-sdk/mcp";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { proxyMcpRequest } from "./model-proxy";

type JsonRecord = Record<string, unknown>;

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  findMcpAppResult: vi.fn(),
  listTools: vi.fn(),
  saveMcpAppResult: vi.fn(),
  withMcpConnectionClient: vi.fn(),
}));

vi.mock("./apps-client", () => ({
  withMcpConnectionClient: mocks.withMcpConnectionClient,
}));
vi.mock("./app-results", () => ({
  findMcpAppResult: mocks.findMcpAppResult,
  saveMcpAppResult: mocks.saveMcpAppResult,
}));

const context = {
  botId: "bot-1",
  botSessionId: "session-1",
  connectionId: "11111111-1111-4111-8111-111111111111",
};

const client = {
  callTool: mocks.callTool,
  initializeResult: {
    capabilities: { tools: {} },
    protocolVersion: "2026-07-28",
    serverInfo: { name: "upstream", version: "1" },
  },
  listTools: mocks.listTools,
};
const resolved = {
  state: {
    allowedTools: ["render", "app_only", "read"],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMcpAppResult.mockResolvedValue(null);
  mocks.withMcpConnectionClient.mockImplementation(
    async (
      _connectionId: string,
      run: (open: {
        client: typeof client;
        resolved: typeof resolved;
      }) => Promise<Response>
    ) => run({ client, resolved })
  );
  mocks.listTools.mockResolvedValue({
    tools: [
      {
        _meta: {
          ui: {
            resourceUri: "ui://widget/dashboard",
            visibility: ["model", "app"],
          },
        },
        description: "Render a widget",
        inputSchema: { properties: {}, type: "object" },
        name: "render",
      },
      {
        _meta: { ui: { visibility: ["app"] } },
        description: "App-only action",
        inputSchema: { properties: {}, type: "object" },
        name: "app_only",
      },
      {
        description: "Read a value",
        inputSchema: { properties: {}, type: "object" },
        name: "read",
      },
    ],
  });
  mocks.callTool.mockResolvedValue({
    _meta: { "ui/private": "never expose this" },
    content: [{ text: "Rendered", type: "text" }],
    structuredContent: { answer: 42 },
  });
  mocks.saveMcpAppResult.mockResolvedValue(
    "22222222-2222-4222-8222-222222222222"
  );
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("MCP model proxy", () => {
  it("advertises the upstream protocol and exposes only model-visible ACL tools", async () => {
    const discovered = await proxyMcpRequest(
      { id: 1, jsonrpc: "2.0", method: "server/discover" },
      context
    );
    expect(await body(discovered)).toMatchObject({
      id: 1,
      result: {
        resultType: "final",
        supportedVersions: ["2026-07-28"],
      },
    });

    const initialized = await proxyMcpRequest(
      { id: 15, jsonrpc: "2.0", method: "initialize" },
      context
    );
    expect(await body(initialized)).toMatchObject({
      id: 15,
      result: { protocolVersion: "2026-07-28" },
    });

    const listed = await proxyMcpRequest(
      { id: 2, jsonrpc: "2.0", method: "tools/list" },
      context
    );
    expect(await body(listed)).toMatchObject({
      result: {
        tools: [{ name: "render" }, { name: "read" }],
      },
    });
  });

  it("strips the private MCP metadata, saves the full result, and returns only an opaque marker", async () => {
    const result = await proxyMcpRequest(
      {
        id: "call",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-1",
              connectionId: context.connectionId,
              resourceUri: "ui://widget/dashboard",
              sessionId: context.botSessionId,
              toolName: "render",
            },
            value: "hello",
          },
          name: "render",
        },
      },
      context
    );
    const output = await body(result);
    expect(mocks.callTool).toHaveBeenCalledWith({
      arguments: { value: "hello" },
      name: "render",
    });
    expect(mocks.saveMcpAppResult).toHaveBeenCalledWith({
      botId: context.botId,
      callId: "call-1",
      connectionId: context.connectionId,
      input: { value: "hello" },
      result: expect.objectContaining({
        _meta: { "ui/private": "never expose this" },
      }),
      sessionId: context.botSessionId,
      toolName: "render",
    });
    expect(output).toMatchObject({
      result: {
        structuredContent: {
          _busyMcpApp: {
            snapshotId: "22222222-2222-4222-8222-222222222222",
          },
          answer: 42,
        },
      },
    });
    expect(JSON.stringify(output)).not.toContain("ui/private");
  });

  it("rejects a stale or mismatched injected session context before calling upstream", async () => {
    const result = await proxyMcpRequest(
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-1",
              connectionId: context.connectionId,
              sessionId: "other-session",
              toolName: "render",
            },
          },
          name: "render",
        },
      },
      context
    );
    expect(result.status).toBe(200);
    expect(await body(result)).toMatchObject({
      error: { code: -32_602 },
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("rechecks live visibility before a stale app-only call", async () => {
    const result = await proxyMcpRequest(
      {
        id: 4,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-1",
              connectionId: context.connectionId,
              resourceUri: "ui://widget/dashboard",
              sessionId: context.botSessionId,
              toolName: "app_only",
            },
          },
          name: "app_only",
        },
      },
      context
    );
    expect(await body(result)).toMatchObject({
      error: { code: -32_409 },
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
  });

  it("validates a tool that appears on a later metadata page", async () => {
    mocks.listTools.mockImplementation(
      (options?: { params?: { cursor?: string } }) => {
        if (options?.params?.cursor === "page-2") {
          return {
            tools: [
              {
                _meta: {
                  ui: {
                    resourceUri: "ui://widget/dashboard",
                    visibility: ["model", "app"],
                  },
                },
                description: "Render a widget",
                inputSchema: { properties: {}, type: "object" },
                name: "render",
              },
            ],
          };
        }
        return {
          nextCursor: "page-2",
          tools: [
            {
              description: "Read a value",
              inputSchema: { properties: {}, type: "object" },
              name: "read",
            },
          ],
        };
      }
    );
    const result = await proxyMcpRequest(
      {
        id: 5,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-1",
              connectionId: context.connectionId,
              resourceUri: "ui://widget/dashboard",
              sessionId: context.botSessionId,
              toolName: "render",
            },
          },
          name: "render",
        },
      },
      context
    );
    expect(await body(result)).toMatchObject({
      result: {
        structuredContent: {
          _busyMcpApp: { snapshotId: expect.any(String) },
        },
      },
    });
    expect(mocks.listTools).toHaveBeenCalledWith({
      params: { cursor: "page-2" },
    });
    expect(mocks.callTool).toHaveBeenCalledWith({
      arguments: {},
      name: "render",
    });
  });

  it("replays an existing snapshot without calling the upstream tool again", async () => {
    mocks.findMcpAppResult.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      snapshot: {
        botId: context.botId,
        callId: "call-1",
        connectionId: context.connectionId,
        input: { value: "hello" },
        result: { structuredContent: { answer: 42 } },
        sessionId: context.botSessionId,
        toolName: "render",
      },
    });
    const result = await proxyMcpRequest(
      {
        id: "retry",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-1",
              connectionId: context.connectionId,
              resourceUri: "ui://widget/dashboard",
              sessionId: context.botSessionId,
              toolName: "render",
            },
            value: "hello",
          },
          name: "render",
        },
      },
      context
    );
    expect(await body(result)).toMatchObject({
      result: {
        structuredContent: {
          _busyMcpApp: {
            snapshotId: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    });
    expect(mocks.callTool).not.toHaveBeenCalled();
    expect(mocks.saveMcpAppResult).not.toHaveBeenCalled();
  });

  it("preserves multimodal content while adding the small marker text", async () => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ data: "aW1hZ2U=", mimeType: "image/png", type: "image" }],
      structuredContent: { answer: 42 },
    });
    const result = await proxyMcpRequest(
      {
        id: "image",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          arguments: {
            __busy: {
              callId: "call-image",
              connectionId: context.connectionId,
              resourceUri: "ui://widget/dashboard",
              sessionId: context.botSessionId,
              toolName: "render",
            },
          },
          name: "render",
        },
      },
      context
    );
    const output = await body(result);
    expect(output.result).toMatchObject({
      content: [
        { data: "aW1hZ2U=", mimeType: "image/png", type: "image" },
        { type: "text" },
      ],
    });
  });

  it("negotiates and calls through the real AI SDK MCP client", async () => {
    const transportFetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const request = JSON.parse(String(init?.body)) as JsonRecord;
      if (request.method === "tools/call") {
        const params = request.params as JsonRecord;
        const args = (params.arguments as JsonRecord | undefined) ?? {};
        params.arguments = {
          ...args,
          __busy: {
            callId: "sdk-call",
            connectionId: context.connectionId,
            resourceUri: "ui://widget/dashboard",
            sessionId: context.botSessionId,
            toolName: "render",
          },
        };
      }
      return await proxyMcpRequest(request, context);
    };
    const mcp = await createMCPClient({
      clientName: "test-client",
      protocolVersionDiscovery: true,
      transport: {
        fetch: transportFetch,
        type: "http",
        url: "https://proxy.test/mcp",
      },
      version: "1.0.0",
    });
    const tools = await mcp.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["render", "read"]);
    const result = await mcp.callTool({
      arguments: { value: "sdk" },
      name: "render",
    });
    expect(result.structuredContent).toMatchObject({
      _busyMcpApp: { snapshotId: "22222222-2222-4222-8222-222222222222" },
    });
    await mcp.close();
  });
});
