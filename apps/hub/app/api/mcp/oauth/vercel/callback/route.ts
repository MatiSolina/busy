import { completeMcpCallback } from "@/lib/mcp/callback";

export const maxDuration = 60;

export function GET(request: Request) {
  return completeMcpCallback(request, undefined, "vercel");
}
