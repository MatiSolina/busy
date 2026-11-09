import { createMCPClient, mcpAppClientCapabilities } from "@ai-sdk/mcp";
import {
  catalogEntry,
  catalogHash,
  MCP_CATALOG_VERSION,
  type McpToolDescriptor,
} from "./catalog";
import { assertPublicHttpUrl, guardedFetch } from "./network";
import { freshToken, McpOAuthProvider } from "./oauth";
import { freshRegisteredToken } from "./registered-oauth";
import {
  listConnections,
  type McpOAuthData,
  type PublicMcpConnectionView,
  publicConnection,
  withConnection,
} from "./store";
import { toolUiMetadata } from "./tool-ui";

/**
 * Discover tools only from the curated catalog endpoint, on the hub server.
 * OAuth tokens are held by the encrypted connection row and never cross this
 * boundary. The result is a reviewed snapshot; runtime ACL checks still read
 * the current hub state before every call.
 */
export async function discoverConnectionTools(
  id: string
): Promise<PublicMcpConnectionView | null> {
  const known = await listConnections();
  const target = known.find((row) => row.id === id);
  if (!target) {
    return null;
  }
  const entry = catalogEntry(target.catalogId);
  if (!entry) {
    throw new Error("This catalog entry was removed.");
  }

  return await withConnection<PublicMcpConnectionView>(
    id,
    async (row, previous) => {
      let data = previous as McpOAuthData;
      let client: Awaited<ReturnType<typeof createMCPClient>> | null = null;
      try {
        await assertPublicHttpUrl(entry.url);
        const headers: Record<string, string> = {};
        if (entry.auth === "oauth") {
          if (!data.redirectOrigin) {
            throw new Error("Reconnect this MCP before discovering tools.");
          }
          const provider = new McpOAuthProvider(data, {
            connectionId: row.id,
            origin: data.redirectOrigin,
            scope: entry.oauthScopes,
          });
          const token = entry.oauthProvider
            ? await freshRegisteredToken(
                provider,
                entry.oauthProvider,
                Date.now()
              )
            : await freshToken(provider, entry.url);
          data = provider.data as McpOAuthData;
          headers.authorization = `Bearer ${token.token}`;
        }

        client = await createMCPClient({
          capabilities: mcpAppClientCapabilities,
          clientName: "BUSY",
          maxRetries: 0,
          protocolVersionDiscovery: true,
          transport: {
            ...(Object.keys(headers).length ? { headers } : {}),
            fetch: (input, init) => guardedFetch(input, init),
            type: entry.transport,
            url: entry.url,
          },
          version: "1.0.0",
        });

        const tools: McpToolDescriptor[] = [];
        let cursor: string | undefined;
        do {
          // biome-ignore lint/performance/noAwaitInLoops: MCP pagination is cursor-ordered.
          const page = await client.listTools({
            ...(cursor ? { params: { cursor } } : {}),
          });
          tools.push(
            ...page.tools.map((tool) => ({
              description: tool.description ?? tool.title ?? tool.name,
              ...(tool.annotations?.destructiveHint === undefined
                ? {}
                : { destructiveHint: tool.annotations.destructiveHint }),
              name: tool.name,
              readOnlyHint: tool.annotations?.readOnlyHint === true,
              ...(toolUiMetadata(tool._meta)
                ? { ui: toolUiMetadata(tool._meta) }
                : {}),
            }))
          );
          cursor = page.nextCursor;
        } while (cursor);

        await client.close();
        client = null;
        const existing = data.busyMcp ?? {};
        const allowedTools = (
          existing.allowedTools ??
          tools
            .filter((tool) => tool.readOnlyHint && !tool.destructiveHint)
            .map((tool) => tool.name)
        ).filter((name) => tools.some((tool) => tool.name === name));
        data.busyMcp = {
          ...existing,
          allowedTools,
          auth: entry.auth,
          catalogHash: catalogHash(entry),
          catalogVersion: MCP_CATALOG_VERSION,
          endpoint: entry.url,
          reviewedAt: new Date().toISOString(),
          scopes: entry.oauthScopes,
          tools,
        };
        return {
          data,
          error: null,
          value: {
            ...publicConnection(row),
            allowedTools,
            catalogHash: catalogHash(entry),
            catalogVersion: MCP_CATALOG_VERSION,
            lifecycle: entry.lifecycle ?? "active",
            reviewedAt: data.busyMcp.reviewedAt,
            tools,
          },
        };
      } catch {
        await client?.close().catch(() => undefined);
        return {
          data,
          error: "Couldn't discover this MCP's tools. Try again or reconnect.",
          status: "error",
          value: publicConnection(row),
        };
      }
    }
  );
}
