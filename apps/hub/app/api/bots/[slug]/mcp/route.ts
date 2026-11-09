import { getBot } from "@/lib/bots/service";
import { mcpJson } from "@/lib/mcp/http";
import {
  addMarketplaceConnection,
  marketplaceSnapshot,
} from "@/lib/mcp/marketplace";

interface Context {
  params: Promise<{ slug: string }>;
}

export async function GET(_req: Request, { params }: Context) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return mcpJson({ error: "Bot not found." }, 404);
  }
  return mcpJson(await marketplaceSnapshot());
}

export async function POST(req: Request, { params }: Context) {
  const bot = await getBot((await params).slug);
  if (!bot) {
    return mcpJson({ error: "Bot not found." }, 404);
  }
  const result = await addMarketplaceConnection(req);
  if ("error" in result) {
    return mcpJson({ error: result.error }, result.status);
  }
  return mcpJson({
    connection: result.connection,
    connectUrl: result.connectUrl,
  });
}
