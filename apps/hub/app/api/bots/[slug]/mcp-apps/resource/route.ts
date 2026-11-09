import {
  McpAppBridgeError,
  mcpAppRequest,
  readMcpAppResource,
  requireMcpAppUser,
} from "@/lib/mcp/apps-client";
import { mcpJson } from "@/lib/mcp/http";

interface Context {
  params: Promise<{ slug: string }>;
}

function errorResponse(error: unknown) {
  if (error instanceof McpAppBridgeError) {
    return mcpJson({ code: error.code, error: error.message }, error.status);
  }
  return mcpJson({ error: "Couldn't load this MCP App." }, 502);
}

export async function POST(req: Request, { params }: Context) {
  try {
    await requireMcpAppUser();
    const body = mcpAppRequest.safeParse(await req.json().catch(() => null));
    if (!body.success) {
      return mcpJson({ error: "Invalid MCP App request." }, 400);
    }
    const { slug } = await params;
    return mcpJson(
      await readMcpAppResource(slug, body.data.callId, body.data.context)
    );
  } catch (error) {
    return errorResponse(error);
  }
}
