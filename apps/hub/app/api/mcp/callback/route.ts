import { completeMcpCallback } from "@/lib/mcp/callback";

export const maxDuration = 60;

export function GET(req: Request) {
  return completeMcpCallback(req);
}
