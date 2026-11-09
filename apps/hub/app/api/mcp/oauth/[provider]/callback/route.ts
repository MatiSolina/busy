import { completeMcpCallback } from "@/lib/mcp/callback";
import { mcpJson } from "@/lib/mcp/http";
import { isRegisteredProvider } from "@/lib/mcp/provider-clients";

export const maxDuration = 60;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  if (!isRegisteredProvider(provider)) {
    return mcpJson({ error: "Provider not found." }, 404);
  }
  return completeMcpCallback(req, provider);
}
