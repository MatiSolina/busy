import { z } from "zod";
import { discoverConnectionTools } from "@/lib/mcp/discovery";
import { connectionId, mcpJson } from "@/lib/mcp/http";
import { updateMarketplaceConnection } from "@/lib/mcp/marketplace";
import { removeConnection, updateAllowedTools } from "@/lib/mcp/store";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  await removeConnection(id);
  return new Response(null, {
    headers: { "Cache-Control": "no-store" },
    status: 204,
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  const input = z
    .object({ allowedTools: z.array(z.string().min(1).max(200)).max(128) })
    .safeParse(await req.json().catch(() => null));
  if (!input.success) {
    return mcpJson({ error: "Choose tools from the reviewed catalog." }, 400);
  }
  try {
    const connection = await updateAllowedTools(id, input.data.allowedTools);
    return connection
      ? mcpJson({ connection })
      : mcpJson({ error: "Connection not found." }, 404);
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 409;
    return mcpJson(
      {
        error:
          error instanceof Error ? error.message : "Couldn't update tools.",
      },
      status === 400 ? 400 : 409
    );
  }
}

/** Accept a reviewed catalog descriptor explicitly. Endpoint/scope changes clear tokens. */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  const result = await updateMarketplaceConnection(id);
  if ("error" in result) {
    return mcpJson({ error: result.error }, result.status);
  }
  return mcpJson({ connection: result.connection });
}

/** Discover the current server tools through the hub-side broker. */
export async function PUT(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!connectionId.safeParse(id).success) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  try {
    const connection = await discoverConnectionTools(id);
    return connection
      ? mcpJson({ connection })
      : mcpJson({ error: "Connection not found." }, 404);
  } catch (error) {
    return mcpJson(
      {
        error:
          error instanceof Error
            ? error.message
            : "Couldn't discover this MCP's tools.",
      },
      409
    );
  }
}
