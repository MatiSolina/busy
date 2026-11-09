import { connection } from "next/server";
import { mcpAppSandboxResponse } from "@/lib/mcp/app-sandbox";

// This page is a public static relay. It never receives app HTML in the URL;
// the authenticated host sends it after the origin-checked ready handshake.
export async function GET(request: Request) {
  await connection();
  const rawCsp = new URL(request.url).searchParams.get("csp");
  let csp: unknown;
  if (rawCsp) {
    try {
      csp = JSON.parse(rawCsp);
    } catch {
      // A manually supplied legacy string is still normalized by the sandbox
      // policy builder; malformed JSON never becomes an HTTP directive.
      csp = rawCsp;
    }
  }
  return mcpAppSandboxResponse(process.env, csp);
}
