import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMarketplaceConnections } from "./marketplace";

const connection = (overrides: Record<string, unknown> = {}) => ({
  auth: "oauth",
  catalogId: "linear",
  description: "Issues and projects.",
  id: "linear-connection",
  name: "Linear",
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  ...overrides,
});
const EVE_CONNECTION_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });

afterEach(() => vi.unstubAllEnvs());

describe("MCP marketplace connection", () => {
  it("loads the current set on every model call so one session sees changes", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ connections: [connection()] }))
      .mockResolvedValueOnce(
        json({
          connections: [
            connection({
              catalogId: "notion",
              id: "notion-connection",
              name: "Notion",
              url: "https://mcp.notion.com/mcp",
            }),
          ],
        })
      );

    const first = await resolveMarketplaceConnections(fetcher);
    const second = await resolveMarketplaceConnections(fetcher);

    expect(Object.keys(first)).toEqual(["mcp-linear"]);
    expect(Object.keys(second)).toEqual(["mcp-notion"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not attach auth to public connections and brokers OAuth tokens on demand", async () => {
    const fetcher = vi.fn(async (path: string) => {
      await Promise.resolve();
      if (path === "/api/bot/mcp") {
        return json({
          connections: [
            connection({
              auth: "none",
              catalogId: "context7",
              id: "context7-connection",
              name: "Context7",
              url: "https://mcp.context7.com/mcp",
            }),
            connection(),
          ],
        });
      }
      expect(path).toBe("/api/bot/mcp/linear-connection/token");
      return json({
        expiresAt: 1_800_000_000_000,
        token: "secret-access-token",
      });
    });

    const definitions = await resolveMarketplaceConnections(fetcher);
    expect(definitions["mcp-context7"]).not.toHaveProperty("auth");
    expect(JSON.stringify(definitions)).not.toContain("secret-access-token");

    const oauth = definitions["mcp-linear"] as unknown as {
      auth: { getToken: () => Promise<{ token: string; expiresAt?: number }> };
    };
    await expect(oauth.auth.getToken()).resolves.toEqual({
      expiresAt: 1_800_000_000_000,
      token: "secret-access-token",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/bot/mcp/linear-connection/token"
    );
  });

  it("fails loudly when the marketplace is unavailable", async () => {
    await expect(
      resolveMarketplaceConnections(
        vi.fn().mockResolvedValue(new Response("down", { status: 503 }))
      )
    ).rejects.toThrow("MCP marketplace is unavailable (HTTP 503)");
    await expect(
      resolveMarketplaceConnections(
        vi.fn().mockRejectedValue(new Error("network down"))
      )
    ).rejects.toThrow("MCP marketplace is unavailable");
  });

  it("fails closed for malformed entries and names duplicate app grants safely", async () => {
    await expect(
      resolveMarketplaceConnections(
        vi
          .fn()
          .mockResolvedValue(
            json({ connections: [connection({ transport: "stdio" })] })
          )
      )
    ).rejects.toThrow("invalid connection");

    const duplicate = await resolveMarketplaceConnections(
      vi.fn().mockResolvedValue(
        json({
          connections: [
            connection(),
            connection({ catalogId: "linear", id: "other" }),
          ],
        })
      )
    );
    expect(Object.keys(duplicate)).toEqual([
      "mcp-linear-linear-connection",
      "mcp-linear-other",
    ]);
  });

  it("keeps legacy connections on approvals until their tools are reviewed", async () => {
    const fetcher = vi.fn().mockImplementation(() =>
      json({
        connections: [connection({ aclMode: "legacy" })],
      })
    );
    const definitions = await resolveMarketplaceConnections(fetcher);
    expect(definitions["mcp-linear"]).not.toHaveProperty("tools");
    const approval = definitions["mcp-linear"] as unknown as {
      approval: {
        request: (context: unknown) => Promise<unknown>;
      };
    };
    await expect(
      approval.approval.request({
        session: { auth: { current: null } },
        toolAnnotations: { readOnlyHint: true },
        toolName: "mcp_linear__read_issue",
      })
    ).resolves.toBe("not-applicable");
  });

  it("maps catalog ids into Eve's lowercase dash-only namespace", async () => {
    const definitions = await resolveMarketplaceConnections(
      vi.fn().mockResolvedValue(
        json({
          connections: [connection({ catalogId: "  Linear CRM / v2  " })],
        })
      )
    );
    expect(Object.keys(definitions)).toEqual(["mcp-linear-crm-v2"]);
    expect(Object.keys(definitions)[0]).toMatch(EVE_CONNECTION_NAME_PATTERN);
  });

  it("bounds long catalog ids to Eve's maximum connection name length", async () => {
    const definitions = await resolveMarketplaceConnections(
      vi.fn().mockResolvedValue(
        json({
          connections: [
            connection({ catalogId: `Long ${"catalog ".repeat(20)}` }),
          ],
        })
      )
    );
    const [name] = Object.keys(definitions);
    expect(name).toHaveLength(64);
    expect(name).toMatch(EVE_CONNECTION_NAME_PATTERN);
  });

  it("keeps normalized catalog collisions distinct and Eve-safe", async () => {
    const definitions = await resolveMarketplaceConnections(
      vi.fn().mockResolvedValue(
        json({
          connections: [
            connection({ catalogId: "Linear CRM", id: "first_connection" }),
            connection({ catalogId: "linear-crm", id: "second.connection" }),
          ],
        })
      )
    );
    const names = Object.keys(definitions);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual([
      "mcp-linear-crm-first-connection",
      "mcp-linear-crm-second-connection",
    ]);
    expect(names.every((name) => EVE_CONNECTION_NAME_PATTERN.test(name))).toBe(
      true
    );
  });

  it("uses the OIDC proxy for MCP Apps and hides app-only tools from the model", async () => {
    vi.stubEnv("HUB_URL", "https://busy.example/");
    const definitions = await resolveMarketplaceConnections(
      vi.fn().mockResolvedValue(
        json({
          connections: [
            connection({
              aclMode: "enforced",
              allowedTools: ["render", "app_only"],
              id: "app-connection",
              tools: [
                {
                  description: "Render a widget",
                  name: "render",
                  readOnlyHint: true,
                  ui: {
                    resourceUri: "ui://widget/index.html",
                    visibility: ["model", "app"],
                  },
                },
                {
                  description: "Internal widget action",
                  name: "app_only",
                  readOnlyHint: true,
                  ui: { visibility: ["app"] },
                },
              ],
            }),
          ],
        })
      )
    );

    const definition = definitions["mcp-linear"] as unknown as {
      auth: unknown;
      headers: (ctx: unknown) => Record<string, string>;
      toolCall: {
        providedArguments: {
          __busy: (ctx: unknown) => unknown;
        };
      };
      tools: { allow: string[] };
      url: string;
    };
    expect(definition.url).toBe(
      "https://busy.example/api/bot/mcp/app-connection/proxy"
    );
    expect(definition.auth).toBeDefined();
    expect(definition.headers({ session: { id: "ordinary-session" } })).toEqual(
      {}
    );
    const firesideId = "11111111-1111-4111-8111-111111111111";
    const participantId = "22222222-2222-4222-8222-222222222222";
    const proof = "a".repeat(64);
    expect(
      definition.headers({
        session: {
          auth: {
            current: {
              principalId: `busy-hub:hub:fireside:${firesideId}:${participantId}:${proof}`,
            },
          },
          id: "isolated-fire-session",
        },
      })
    ).toEqual({
      "x-busy-fireside-id": firesideId,
      "x-busy-fireside-participant": participantId,
      "x-busy-fireside-proof": proof,
      "x-busy-fireside-session": "isolated-fire-session",
    });
    expect(definition.tools.allow).toEqual(["render"]);
    expect(
      definition.toolCall.providedArguments.__busy({
        callId: "call-1",
        session: { id: "session-1" },
        toolName: "render",
      })
    ).toEqual({
      callId: "call-1",
      connectionId: "app-connection",
      resourceUri: "ui://widget/index.html",
      sessionId: "session-1",
      toolName: "render",
    });
  });

  it("offers a consultation no MCP connection at all (H-07)", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        connections: [
          connection({
            aclMode: "enforced",
            allowedTools: ["search"],
            tools: [
              { description: "Search", name: "search", readOnlyHint: true },
            ],
          }),
          connection({ aclMode: "legacy", catalogId: "notion", id: "n" }),
        ],
      })
    );
    await expect(resolveMarketplaceConnections(fetcher, true)).resolves.toEqual(
      {}
    );
    // The user's chat still gets both connections from the same hub answer.
    await expect(
      resolveMarketplaceConnections(fetcher, false).then(Object.keys)
    ).resolves.toEqual(["mcp-linear", "mcp-notion"]);
  });
});
