import { describe, expect, it } from "vitest";
import {
  assertPublicHttpUrl,
  guardedFetch,
  isPrivateIp,
  type McpNetworkError,
} from "./network";

const publicLookup = async () => [{ address: "93.184.216.34" }];

describe("MCP network guard", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.2",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
  ])("recognizes private address %s", (address) =>
    expect(isPrivateIp(address)).toBe(true)
  );

  it("rejects credentials and private literal URLs before fetch", async () => {
    await expect(
      assertPublicHttpUrl("https://user:pass@example.com/mcp", {
        lookupFn: publicLookup,
      })
    ).rejects.toMatchObject({
      code: "invalid_url",
    });
    await expect(
      assertPublicHttpUrl("https://127.0.0.1/mcp", { lookupFn: publicLookup })
    ).rejects.toMatchObject({
      code: "private_host",
    });
  });

  it("rejects a DNS answer containing a private address", async () => {
    await expect(
      assertPublicHttpUrl("https://rebound.example/mcp", {
        lookupFn: async () => [
          { address: "93.184.216.34" },
          { address: "10.0.0.1" },
        ],
      })
    ).rejects.toMatchObject({ code: "private_host" });
  });

  it("validates every redirect and follows a bounded safe redirect", async () => {
    const seen: string[] = [];
    const response = await guardedFetch(
      "https://start.example/mcp",
      undefined,
      {
        fetchFn: // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
          async (input) => {
            const url = String(input);
            seen.push(url);
            if (seen.length === 1) {
              return Response.redirect("https://next.example/mcp", 302);
            }
            return new Response("ok", { status: 200 });
          },
        lookupFn: publicLookup,
      }
    );
    expect(await response.text()).toBe("ok");
    expect(seen).toEqual([
      "https://start.example/mcp",
      "https://next.example/mcp",
    ]);
  });

  it("blocks a redirect to a private address and does not call it", async () => {
    const fetchFn = async () =>
      Response.redirect("https://127.0.0.1/private", 302);
    await expect(
      guardedFetch("https://start.example/mcp", undefined, {
        fetchFn,
        lookupFn: publicLookup,
      })
    ).rejects.toMatchObject({ code: "private_host" });
  });

  it("does not follow a credential-bearing POST across origins", async () => {
    const seen: string[] = [];
    const fetchFn = // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
      async (input: RequestInfo | URL) => {
        seen.push(String(input));
        return Response.redirect("https://other.example/token", 307);
      };
    await expect(
      guardedFetch(
        "https://start.example/token",
        {
          body: "refresh_token=secret",
          headers: { authorization: "Bearer secret" },
          method: "POST",
        },
        { fetchFn, lookupFn: publicLookup }
      )
    ).rejects.toMatchObject({ code: "invalid_url" });
    expect(seen).toEqual(["https://start.example/token"]);
  });

  it("honors an already-aborted caller signal before invoking fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await expect(
      guardedFetch(
        "https://start.example/mcp",
        { signal: controller.signal },
        {
          fetchFn: // biome-ignore lint/suspicious/useAwait: The injected fetch contract returns a promise even for immediate test responses.
            async () => {
              called = true;
              return new Response("unexpected");
            },
          lookupFn: publicLookup,
        }
      )
    ).rejects.toMatchObject({ code: "timeout" });
    expect(called).toBe(false);
  });

  it("limits redirect loops", async () => {
    const fetchFn = async (input: RequestInfo | URL) =>
      new Response(null, { headers: { location: String(input) }, status: 302 });
    await expect(
      guardedFetch("https://start.example/mcp", undefined, {
        fetchFn,
        lookupFn: publicLookup,
        maxRedirects: 1,
      })
    ).rejects.toMatchObject({
      code: "redirect_limit",
    } satisfies Partial<McpNetworkError>);
  });
});
