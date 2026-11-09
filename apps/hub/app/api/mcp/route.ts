import { mcpJson } from "@/lib/mcp/http";
import {
  addMarketplaceConnection,
  marketplaceSnapshot,
} from "@/lib/mcp/marketplace";

export async function GET() {
  return mcpJson(await marketplaceSnapshot());
}

export async function POST(req: Request) {
  const result = await addMarketplaceConnection(req);
  if ("error" in result) {
    return mcpJson({ error: result.error }, result.status);
  }
  return mcpJson({
    connection: result.connection,
    connectUrl: result.connectUrl,
  });
}
