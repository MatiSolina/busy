import { registeredHubOrigin } from "@/lib/mcp/provider-origin";
import { vercelCimdMetadata } from "@/lib/mcp/registered-oauth";

/** Public CIMD document; it is bound to the configured Hub origin, never Host. */
export function GET(request: Request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = registeredHubOrigin(requestOrigin);
  return Response.json(vercelCimdMetadata(origin), {
    headers: {
      "Cache-Control": "public, max-age=300",
    },
  });
}
