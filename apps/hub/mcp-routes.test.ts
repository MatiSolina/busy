import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as getBotMcp } from "./app/api/bot/mcp/route";
import {
  DELETE as deleteMcp,
  PUT as discoverMcp,
  PATCH as patchMcp,
  POST as reviewMcp,
} from "./app/api/mcp/[id]/route";
import {
  GET as getMarketplace,
  POST as postMarketplace,
} from "./app/api/mcp/route";

const mocks = vi.hoisted(() => ({
  addConnection: vi.fn(),
  botFromRequest: vi.fn(),
  discoverConnectionTools: vi.fn(),
  findConnection: vi.fn(),
  getBot: vi.fn(),
  getProviderClient: vi.fn(),
  listConnections: vi.fn(),
  removeConnection: vi.fn(),
  updateAllowedTools: vi.fn(),
  updateMarketplaceConnection: vi.fn(),
  withConnection: vi.fn(),
}));

vi.mock("@/lib/bots/service", () => ({ getBot: mocks.getBot }));
vi.mock("@/lib/bot-auth", () => ({ botFromRequest: mocks.botFromRequest }));
vi.mock("@/lib/mcp/store", () => ({
  addConnection: mocks.addConnection,
  findConnection: mocks.findConnection,
  listConnections: mocks.listConnections,
  publicConnection: (row: Record<string, unknown>) => ({
    catalogId: row.catalogId,
    error: row.error ?? null,
    id: row.id,
    status: row.status,
  }),
  publicConnectionView: (row: Record<string, unknown>) => ({
    catalogId: row.catalogId,
    error: row.error ?? null,
    id: row.id,
    status: row.status,
  }),
  removeConnection: mocks.removeConnection,
  updateAllowedTools: mocks.updateAllowedTools,
  withConnection: mocks.withConnection,
}));
vi.mock("@/lib/mcp/discovery", () => ({
  discoverConnectionTools: mocks.discoverConnectionTools,
}));
vi.mock("@/lib/mcp/marketplace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp/marketplace")>();
  return {
    ...actual,
    updateMarketplaceConnection: mocks.updateMarketplaceConnection,
  };
});
vi.mock("@/lib/mcp/provider-clients", () => ({
  getProviderClient: mocks.getProviderClient,
}));

const alpha = { id: "bot-alpha", slug: "alpha" };
const beta = { id: "bot-beta", slug: "beta" };
const oauthConnection = {
  botId: alpha.id,
  catalogId: "linear",
  error: null,
  id: "11111111-1111-4111-8111-111111111111",
  oauthData: "v1.encrypted.secret",
  status: "pending" as const,
};

const jsonRequest = (body: unknown) =>
  new Request("http://busy.test/api/mcp", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getBot.mockImplementation(async (slug: string) =>
    // biome-ignore lint/style/noNestedTernary: fixture lookup keeps the two supported test identities explicit.
    slug === alpha.slug ? alpha : slug === beta.slug ? beta : undefined
  );
  mocks.botFromRequest.mockResolvedValue({ slug: alpha.slug });
  mocks.listConnections.mockResolvedValue([]);
  mocks.findConnection.mockResolvedValue(null);
  mocks.removeConnection.mockResolvedValue(undefined);
  mocks.getProviderClient.mockResolvedValue(null);
  mocks.withConnection.mockImplementation(
    async (
      _id: string,
      run: (
        row: typeof oauthConnection,
        data: Record<string, unknown>
      ) => Promise<{ value: unknown }>
    ) => {
      const result = await run(oauthConnection, {});
      return result.value;
    }
  );
});

describe("MCP marketplace routes", () => {
  it("returns only catalogue metadata and public connection fields", async () => {
    mocks.listConnections.mockResolvedValue([
      { ...oauthConnection, status: "pending" },
      {
        ...oauthConnection,
        catalogId: "context7",
        id: "22222222-2222-4222-8222-222222222222",
        status: "connected",
      },
    ]);

    const response = await getMarketplace();
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(
      body.catalog.some((entry: { id: string }) => entry.id === "linear")
    ).toBe(true);
    expect(body.connections).toEqual([
      {
        catalogId: "linear",
        error: null,
        id: "11111111-1111-4111-8111-111111111111",
        status: "pending",
      },
      {
        catalogId: "context7",
        error: null,
        id: "22222222-2222-4222-8222-222222222222",
        status: "connected",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain("oauthData");
    expect(JSON.stringify(body)).not.toContain("encrypted.secret");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unknown catalogue id before writing a connection", async () => {
    const response = await postMarketplace(
      jsonRequest({ catalogId: "internal-admin-mcp" })
    );
    expect(response.status).toBe(400);
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it("exposes only configured provider flags and never returns provider secrets", async () => {
    mocks.getProviderClient.mockImplementation(async (provider: string) =>
      provider === "github"
        ? {
            clientId: "github-client",
            clientSecret: "github-secret",
            version: "v1",
          }
        : null
    );
    const response = await getMarketplace();
    const body = await response.json();
    expect(
      body.catalog.find((entry: { id: string }) => entry.id === "github")
    ).toMatchObject({ configured: true });
    expect(
      body.catalog.find((entry: { id: string }) => entry.id === "gmail")
    ).toMatchObject({ configured: false });
    expect(JSON.stringify(body)).not.toContain("github-secret");
    expect(JSON.stringify(body)).not.toContain("clientSecret");
  });

  it("rejects a registered MCP before creating a row when its provider client is not configured", async () => {
    const response = await postMarketplace(
      jsonRequest({ catalogId: "github" })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Set up GitHub before connecting this app.",
    });
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it("creates an app-level OAuth connect URL", async () => {
    mocks.addConnection.mockResolvedValue(oauthConnection);
    const response = await postMarketplace(
      jsonRequest({ catalogId: "linear" })
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(mocks.addConnection).toHaveBeenCalledWith("linear");
    expect(body.connection).toEqual({
      catalogId: "linear",
      error: null,
      id: oauthConnection.id,
      status: "pending",
    });
    expect(body.connectUrl).toMatch(
      new RegExp(`^/api/mcp/${oauthConnection.id}/connect\\?ticket=.+$`, "u")
    );
  });

  it("reconnects the requested grant without replacing another grant", async () => {
    const first = {
      ...oauthConnection,
      id: "11111111-1111-4111-8111-111111111111",
    };
    const second = {
      ...oauthConnection,
      id: "22222222-2222-4222-8222-222222222222",
    };
    mocks.findConnection.mockResolvedValue(second);
    mocks.withConnection.mockImplementation(
      async (
        id: string,
        run: (
          row: typeof oauthConnection,
          data: Record<string, unknown>
        ) => Promise<{ value: unknown }>
      ) => (await run(id === second.id ? second : first, {})).value
    );

    const response = await postMarketplace(
      jsonRequest({ catalogId: "linear", connectionId: second.id })
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(mocks.findConnection).toHaveBeenCalledWith(second.id);
    expect(mocks.addConnection).not.toHaveBeenCalled();
    expect(body.connection.id).toBe(second.id);
    expect(body.connectUrl).toMatch(
      new RegExp(`^/api/mcp/${second.id}/connect\\?ticket=.+$`, "u")
    );
  });

  it("rejects malformed connection IDs before looking up a grant", async () => {
    const response = await postMarketplace(
      jsonRequest({ catalogId: "linear", connectionId: "not-a-uuid" })
    );
    expect(response.status).toBe(400);
    expect(mocks.findConnection).not.toHaveBeenCalled();
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it("does not reconnect a grant under a different catalog", async () => {
    mocks.findConnection.mockResolvedValue({
      ...oauthConnection,
      catalogId: "context7",
    });
    const response = await postMarketplace(
      jsonRequest({
        catalogId: "linear",
        connectionId: oauthConnection.id,
      })
    );
    expect(response.status).toBe(404);
    expect(mocks.addConnection).not.toHaveBeenCalled();
  });

  it("publishes only connected entries to the bot runtime", async () => {
    mocks.listConnections.mockResolvedValue([
      { ...oauthConnection, status: "connected" },
      {
        ...oauthConnection,
        catalogId: "context7",
        id: "22222222-2222-4222-8222-222222222222",
        status: "connected",
      },
      {
        ...oauthConnection,
        catalogId: "notion",
        error: "authorization failed",
        id: "33333333-3333-4333-8333-333333333333",
        status: "error",
      },
    ]);

    const response = await getBotMcp(
      new Request("http://busy.test/api/bot/mcp")
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(
      body.connections.map((entry: { catalogId: string }) => entry.catalogId)
    ).toEqual(["linear", "context7"]);
    expect(body.connections[0]).toMatchObject({
      auth: "oauth",
      id: oauthConnection.id,
      name: "Linear",
    });
    expect(body.connections[1]).toMatchObject({
      auth: "none",
      name: "Context7",
    });
    expect(JSON.stringify(body)).not.toContain("authorization failed");
    expect(JSON.stringify(body)).not.toContain("oauthData");
  });

  it("propagates bot authentication failures without querying the catalogue", async () => {
    mocks.botFromRequest.mockResolvedValue(
      new Response("unauthorized", { status: 401 })
    );
    const response = await getBotMcp(
      new Request("http://busy.test/api/bot/mcp")
    );
    expect(response.status).toBe(401);
    expect(mocks.getBot).not.toHaveBeenCalled();
    expect(mocks.listConnections).not.toHaveBeenCalled();
  });

  it("deletes an app connection and rejects malformed ids", async () => {
    // biome-ignore lint/style/useDestructuring: test shape is intentionally accessed by property for the assertion under test.
    const id = oauthConnection.id;
    const deleted = await deleteMcp(new Request("http://busy.test"), {
      params: Promise.resolve({ id }),
    });
    expect(deleted.status).toBe(204);
    expect(mocks.removeConnection).toHaveBeenCalledWith(id);

    const malformed = await deleteMcp(new Request("http://busy.test"), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(malformed.status).toBe(404);
    expect(mocks.removeConnection).toHaveBeenCalledOnce();
  });

  it("updates the connection allowlist through the app route", async () => {
    mocks.updateAllowedTools.mockResolvedValue({
      allowedTools: ["list_issues"],
      catalogId: "linear",
      error: null,
      id: oauthConnection.id,
      status: "connected",
    });
    const response = await patchMcp(
      new Request(`http://busy.test/api/mcp/${oauthConnection.id}`, {
        body: JSON.stringify({ allowedTools: ["list_issues"] }),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      }),
      { params: Promise.resolve({ id: oauthConnection.id }) }
    );
    expect(response.status).toBe(200);
    expect(mocks.updateAllowedTools).toHaveBeenCalledWith(oauthConnection.id, [
      "list_issues",
    ]);
  });

  it("keeps discovery and descriptor review as explicit writes", async () => {
    mocks.discoverConnectionTools.mockResolvedValue({
      catalogId: "linear",
      error: null,
      id: oauthConnection.id,
      lifecycle: "active",
      status: "connected",
      tools: [],
    });
    mocks.updateMarketplaceConnection.mockResolvedValue({
      connection: {
        catalogId: "linear",
        error: null,
        id: oauthConnection.id,
        lifecycle: "active",
        status: "connected",
      },
      status: 200,
    });

    const discovered = await discoverMcp(
      new Request(`http://busy.test/api/mcp/${oauthConnection.id}`),
      { params: Promise.resolve({ id: oauthConnection.id }) }
    );
    expect(discovered.status).toBe(200);
    expect(mocks.discoverConnectionTools).toHaveBeenCalledWith(
      oauthConnection.id
    );

    const reviewed = await reviewMcp(
      new Request(`http://busy.test/api/mcp/${oauthConnection.id}`),
      { params: Promise.resolve({ id: oauthConnection.id }) }
    );
    expect(reviewed.status).toBe(200);
    expect(mocks.updateMarketplaceConnection).toHaveBeenCalledWith(
      oauthConnection.id
    );
  });
});
