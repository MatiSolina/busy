import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { catalogEntry } from "@/lib/mcp/catalog";
import { mcpJson } from "@/lib/mcp/http";
import { listConnections, publicConnectionView } from "@/lib/mcp/store";

export async function GET(req: Request) {
  const caller = await botFromRequest(req);
  if (caller instanceof Response) {
    return caller;
  }
  const bot = await getBot(caller.slug);
  if (!bot) {
    return mcpJson({ error: "Bot not found." }, 404);
  }
  const rows = await listConnections();
  const views = await Promise.all(rows.map(publicConnectionView));
  const connections = views.flatMap((row) => {
    const entry = catalogEntry(row.catalogId);
    const lifecycle = row.lifecycle ?? "active";
    if (
      !entry ||
      row.status !== "connected" ||
      lifecycle === "update" ||
      lifecycle === "removed"
    ) {
      return [];
    }
    return [
      {
        auth: entry.auth,
        ...(row.aclMode ? { aclMode: row.aclMode } : {}),
        catalogId: entry.id,
        description: entry.description,
        id: row.id,
        ...(row.allowedTools ? { allowedTools: row.allowedTools } : {}),
        ...(row.catalogHash ? { catalogHash: row.catalogHash } : {}),
        ...(row.catalogVersion ? { catalogVersion: row.catalogVersion } : {}),
        ...(row.lifecycle ? { lifecycle: row.lifecycle } : {}),
        name: entry.name,
        ...(row.tools ? { tools: row.tools } : {}),
        transport: entry.transport,
        url: entry.url,
      },
    ];
  });
  return mcpJson({ connections });
}
