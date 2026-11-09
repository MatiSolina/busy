import { getBot } from "@/lib/bots/service";
import { connectionId, mcpJson } from "@/lib/mcp/http";
import { removeConnection } from "@/lib/mcp/store";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ slug: string; id: string }> }
) {
  const { slug, id } = await params;
  const bot = await getBot(slug);
  if (!(bot && connectionId.safeParse(id).success)) {
    return mcpJson({ error: "Connection not found." }, 404);
  }
  await removeConnection(id);
  return new Response(null, {
    headers: { "Cache-Control": "no-store" },
    status: 204,
  });
}
