import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as readResource } from "./app/api/bots/[slug]/mcp-apps/resource/route";
import { POST as callTool } from "./app/api/bots/[slug]/mcp-apps/tool/route";

const mocks = vi.hoisted(() => ({
  ApprovalError: class extends Error {
    approval = "approval-token";
    argumentsHash = "hash";
    code = "approval_required";
    expiresAt = 1_700_000_000_000;
    nameForApproval = "send_message";
    status = 409;
  },
  BridgeError: class extends Error {
    code = "not_found";
    status = 404;
  },
  callMcpAppTool: vi.fn(),
  readMcpAppResource: vi.fn(),
  requireMcpAppUser: vi.fn(),
}));

vi.mock("@/lib/mcp/apps-client", () => ({
  approvalDetails: (error: {
    approval: string;
    argumentsHash: string;
    expiresAt: number;
    nameForApproval: string;
  }) => ({
    approval: error.approval,
    argumentsHash: error.argumentsHash,
    expiresAt: error.expiresAt,
    name: error.nameForApproval,
  }),
  callMcpAppTool: mocks.callMcpAppTool,
  McpAppApprovalRequiredError: mocks.ApprovalError,
  McpAppBridgeError: mocks.BridgeError,
  mcpAppRequest: {
    safeParse: (value: unknown) => ({ data: value, success: true }),
  },
  mcpAppToolRequest: {
    safeParse: (value: unknown) => ({ data: value, success: true }),
  },
  readMcpAppResource: mocks.readMcpAppResource,
  requireMcpAppUser: mocks.requireMcpAppUser,
}));

const params = Promise.resolve({ slug: "alpha" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireMcpAppUser.mockResolvedValue(undefined);
});

describe("MCP Apps bridge routes", () => {
  it("accepts only the server-derived call id for resource loading", async () => {
    mocks.readMcpAppResource.mockResolvedValue({
      allowedTools: ["read_issue"],
      app: {
        connectionId: "connection-1",
        input: { issue: 3 },
        resourceUri: "ui://issues/card",
        result: { title: "Issue" },
        toolName: "mcp_linear__read_issue",
      },
      resource: {
        html: "<html></html>",
        mimeType: "text/html;profile=mcp-app",
        uri: "ui://issues/card",
      },
      sandboxUrl: "https://sandbox.example.com/mcp-app-sandbox",
    });

    const response = await readResource(
      new Request("https://busy.test/api/bots/alpha/mcp-apps/resource", {
        body: JSON.stringify({ callId: "call-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params }
    );

    expect(response.status).toBe(200);
    expect(mocks.readMcpAppResource).toHaveBeenCalledWith(
      "alpha",
      "call-1",
      undefined
    );
    expect(await response.json()).toMatchObject({
      app: { toolName: "mcp_linear__read_issue" },
      sandboxUrl: "https://sandbox.example.com/mcp-app-sandbox",
    });
  });

  it("keeps approval_required structured for an app write", async () => {
    mocks.callMcpAppTool.mockRejectedValue(new mocks.ApprovalError());

    const response = await callTool(
      new Request("https://busy.test/api/bots/alpha/mcp-apps/tool", {
        body: JSON.stringify({
          arguments: { text: "hello" },
          callId: "call-1",
          name: "send_message",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      approval: "approval-token",
      code: "approval_required",
      name: "send_message",
    });
  });

  it("does not expose a resource or tool without the browser session", async () => {
    mocks.requireMcpAppUser.mockRejectedValue(new mocks.BridgeError());
    const response = await readResource(
      new Request("https://busy.test/api/bots/alpha/mcp-apps/resource", {
        body: JSON.stringify({ callId: "call-1" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params }
    );
    expect(response.status).toBe(404);
    expect(mocks.readMcpAppResource).not.toHaveBeenCalled();
  });
});
