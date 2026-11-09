import { botFromRequest } from "@/lib/bot-auth";
import { getBot } from "@/lib/bots/service";
import { runtimeParticipant } from "@/lib/firesides/auth";
import { connectionId, mcpJson } from "@/lib/mcp/http";
import { proxyMcpRequest } from "@/lib/mcp/model-proxy";

export async function POST(
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
  // Select an isolated session only from its verified runtime grant. Tool
  // arguments remain untrusted and cannot choose a different session.
  const fireside = req.headers.has("x-busy-fireside-id")
    ? await runtimeParticipant(req, caller.slug)
    : null;
  if (req.headers.has("x-busy-fireside-id") && !fireside) {
    return mcpJson({ error: "Fireside session unavailable." }, 403);
  }
  const body = await req.json().catch(() => null);
  return await proxyMcpRequest(body, {
    botId: bot.id,
    botSessionId: fireside?.sessionId ?? bot.sessionId,
    connectionId: id,
  });
}
