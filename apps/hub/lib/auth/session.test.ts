import { describe, expect, it } from "vitest";
import { isPublicPath } from "./session";

describe("public authentication paths", () => {
  it("allows only the exact CIMD and MCP app sandbox paths", () => {
    expect(isPublicPath("/.well-known/busy-mcp-client")).toBe(true);
    expect(isPublicPath("/.well-known/busy-mcp-client/")).toBe(false);
    expect(isPublicPath("/.well-known/busy-mcp-client.json")).toBe(false);
    expect(isPublicPath("/.well-known/busy-mcp-client/other")).toBe(false);
    expect(isPublicPath("/mcp-app-sandbox")).toBe(true);
    expect(isPublicPath("/mcp-app-sandbox/")).toBe(false);
    expect(isPublicPath("/mcp-app-sandbox/other")).toBe(false);
    expect(isPublicPath("/api/mcp/oauth/vercel/callback")).toBe(false);
  });
});
