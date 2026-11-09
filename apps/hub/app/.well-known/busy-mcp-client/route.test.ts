import { describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("Vercel MCP CIMD document", () => {
  it("uses the configured origin for the client id and callback", async () => {
    vi.stubEnv("HUB_URL", "https://busy.example.com");
    try {
      const response = GET(
        new Request("https://busy.example.com/.well-known/busy-mcp-client")
      );
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        client_id: "https://busy.example.com/.well-known/busy-mcp-client",
        redirect_uris: [
          "https://busy.example.com/api/mcp/oauth/vercel/callback",
        ],
        token_endpoint_auth_method: "none",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a forwarded or untrusted request origin", () => {
    vi.stubEnv("HUB_URL", "https://busy.example.com");
    try {
      expect(() =>
        GET(new Request("https://attacker.example/.well-known/busy-mcp-client"))
      ).toThrow("configured hub origin");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
