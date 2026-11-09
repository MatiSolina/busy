import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { catalogEntry } from "@/lib/mcp/catalog";
import { connectionId, mcpJson } from "@/lib/mcp/http";
import {
  freshToken,
  McpOAuthProvider,
  McpReconnectError,
} from "@/lib/mcp/oauth";
import { getProviderClient } from "@/lib/mcp/provider-clients";
import { freshRegisteredToken } from "@/lib/mcp/registered-oauth";
import { withConnection } from "@/lib/mcp/store";

export const maxDuration = 60;
interface TokenResult {
  body: { token: string; expiresAt?: number } | { error: string };
  status: number;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  const bot = await getBot(caller.slug);
  if (!bot) {
    return mcpJson({ error: "Bot not found." }, 404);
  }
  try {
    const result = await withConnection<TokenResult>(id, async (row, data) => {
      const entry = catalogEntry(row.catalogId);
      if (
        row.status !== "connected" ||
        !entry ||
        entry.auth !== "oauth" ||
        !data.redirectOrigin
      ) {
        return {
          data,
          value: {
            body: { error: "Reconnect this MCP in the marketplace." },
            status: 409,
          },
        };
      }
      const provider = new McpOAuthProvider(data, {
        connectionId: id,
        origin: data.redirectOrigin,
        scope: entry.oauthScopes,
      });
      try {
        if (entry.oauthProvider) {
          const currentClient = await getProviderClient(entry.oauthProvider);
          if (
            !currentClient ||
            currentClient.version !== data.registeredClientVersion
          ) {
            throw new McpReconnectError();
          }
        }
        const token = entry.oauthProvider
          ? await freshRegisteredToken(provider, entry.oauthProvider)
          : await freshToken(provider, entry.url, Date.now(), {
              scope: entry.oauthScopes,
            });
        return { data: provider.data, value: { body: token, status: 200 } };
      } catch (error) {
        if (error instanceof McpReconnectError) {
          provider.invalidateCredentials("tokens");
          provider.invalidateCredentials("verifier");
          return {
            data: provider.data,
            error:
              "Authorization expired or was revoked. Reconnect this service.",
            status: "error",
            value: {
              body: { error: "Reconnect this MCP in the marketplace." },
              status: 409,
            },
          };
        }
        return {
          data: provider.data,
          value: {
            body: { error: "MCP authorization is temporarily unavailable." },
            status: 502,
          },
        };
      }
    });
    return result
      ? mcpJson(result.body, result.status)
      : mcpJson({ error: "Connection not found." }, 404);
  } catch {
    return mcpJson(
      { error: "MCP authorization is temporarily unavailable." },
      502
    );
  }
}
