import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./app/api/bot/mcp/[id]/proxy/route";

const mocks = vi.hoisted(() => ({
  botFromRequest: vi.fn(),
  getBot: vi.fn(),
  proxyMcpRequest: vi.fn(),
  runtimeParticipant: vi.fn(),
}));

vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/firesides/auth", () => ({
  runtimeParticipant: mocks.runtimeParticipant,
}));
vi.mock("@/lib/mcp/model-proxy", () => ({
  proxyMcpRequest: mocks.proxyMcpRequest,
}));

const connectionId = "11111111-1111-4111-8111-111111111111";
const bot = { id: "bot-1", sessionId: "session-1", slug: "builder" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.botFromRequest.mockResolvedValue({ slug: bot.slug });
  mocks.getBot.mockResolvedValue(bot);
  mocks.runtimeParticipant.mockResolvedValue(null);
  mocks.proxyMcpRequest.mockResolvedValue(
    Response.json({ id: 1, jsonrpc: "2.0", result: {} })
  );
});

describe("MCP model proxy route", () => {
  it("requires bot authentication before reading the body", async () => {
    const unauthorized = new Response("unauthorized", { status: 401 });
    mocks.botFromRequest.mockResolvedValue(unauthorized);
    const response = await POST(
      new Request("http://busy.test", {
        body: "not-json",
        method: "POST",
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    expect(response).toBe(unauthorized);
    expect(mocks.proxyMcpRequest).not.toHaveBeenCalled();
  });

  it("passes the authenticated bot and connection provenance to the proxy", async () => {
    const payload = { id: 1, jsonrpc: "2.0", method: "tools/list" };
    await POST(
      new Request("http://busy.test", {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    expect(mocks.proxyMcpRequest).toHaveBeenCalledWith(payload, {
      botId: bot.id,
      botSessionId: bot.sessionId,
      connectionId,
    });
  });

  it("rejects malformed connection ids before hitting the proxy", async () => {
    const response = await POST(
      new Request("http://busy.test", { method: "POST" }),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(response.status).toBe(404);
    expect(mocks.proxyMcpRequest).not.toHaveBeenCalled();
  });

  it("uses the verified fireside session instead of the bot's ordinary session", async () => {
    mocks.runtimeParticipant.mockResolvedValue({
      sessionId: "isolated-fire-session",
    });
    const payload = {
      id: 2,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        arguments: { __busy: { sessionId: "isolated-fire-session" } },
        name: "render",
      },
    };
    const request = new Request("http://busy.test", {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "x-busy-fireside-id": "fire",
      },
      method: "POST",
    });
    await POST(request, { params: Promise.resolve({ id: connectionId }) });
    expect(mocks.runtimeParticipant).toHaveBeenCalledWith(request, bot.slug);
    expect(mocks.proxyMcpRequest).toHaveBeenCalledWith(payload, {
      botId: bot.id,
      botSessionId: "isolated-fire-session",
      connectionId,
    });
  });

  it("rejects expired or forged fireside grants without falling back to ordinary chat", async () => {
    const response = await POST(
      new Request("http://busy.test", {
        body: "not-json",
        headers: { "x-busy-fireside-id": "forged" },
        method: "POST",
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    expect(response.status).toBe(403);
    expect(mocks.proxyMcpRequest).not.toHaveBeenCalled();
  });

  it("does not authorize an isolated session just because tool arguments name it", async () => {
    const payload = {
      id: 3,
      jsonrpc: "2.0",
      method: "tools/call",
      params: { arguments: { __busy: { sessionId: "isolated-fire-session" } } },
    };
    await POST(
      new Request("http://busy.test", {
        body: JSON.stringify(payload),
        method: "POST",
      }),
      { params: Promise.resolve({ id: connectionId }) }
    );
    expect(mocks.runtimeParticipant).not.toHaveBeenCalled();
    expect(mocks.proxyMcpRequest).toHaveBeenCalledWith(payload, {
      botId: bot.id,
      botSessionId: bot.sessionId,
      connectionId,
    });
  });
});
