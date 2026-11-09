import {
  approvalDetails,
  callMcpAppTool,
  McpAppApprovalRequiredError,
  McpAppBridgeError,
  mcpAppToolRequest,
  requireMcpAppUser,
} from "@/lib/mcp/apps-client";
import { mcpJson } from "@/lib/mcp/http";

interface Context {
  params: Promise<{ slug: string }>;
}

function errorResponse(error: unknown) {
  if (error instanceof McpAppApprovalRequiredError) {
    return mcpJson(
      {
        code: error.code,
        error: error.message,
        ...approvalDetails(error),
      },
      error.status
    );
  }
  if (error instanceof McpAppBridgeError) {
    return mcpJson({ code: error.code, error: error.message }, error.status);
  }
  return mcpJson({ error: "The MCP App tool call failed." }, 502);
}

export async function POST(req: Request, { params }: Context) {
  try {
    await requireMcpAppUser();
    const body = mcpAppToolRequest.safeParse(
      await req.json().catch(() => null)
    );
    if (!body.success) {
      return mcpJson({ error: "Invalid MCP App tool call." }, 400);
    }
    const { slug } = await params;
    return mcpJson(await callMcpAppTool(slug, body.data));
  } catch (error) {
    return errorResponse(error);
  }
}
