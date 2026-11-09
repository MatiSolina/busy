import { describe, expect, it } from "vitest";
import {
  injectMcpAppCsp,
  MCP_APP_DEFAULT_CSP,
  mcpAppCsp,
  mcpAppSandboxHeaders,
  mcpAppSandboxHtml,
  mcpAppSandboxOrigins,
  mcpAppSandboxResponse,
  mcpAppSandboxUrl,
} from "./app-sandbox";

const SANDBOX_ORIGIN_ERROR = /MCP_APP_SANDBOX_ORIGIN/iu;
const DISTINCT_ORIGIN_ERROR = /must differ/iu;
const REMOTE_SCRIPT_TAG = /<script\s+src=/iu;

describe("MCP App sandbox origins", () => {
  it("requires a distinct HTTPS sandbox origin in production", () => {
    expect(() =>
      mcpAppSandboxOrigins({
        HUB_URL: "https://busy.example.com",
        NODE_ENV: "production",
      })
    ).toThrow(SANDBOX_ORIGIN_ERROR);
    expect(() =>
      mcpAppSandboxOrigins({
        HUB_URL: "https://busy.example.com",
        MCP_APP_SANDBOX_ORIGIN: "https://busy.example.com",
        NODE_ENV: "production",
      })
    ).toThrow(DISTINCT_ORIGIN_ERROR);
  });

  it("uses the configured origins and never trusts request input", () => {
    const environment = {
      HUB_URL: "https://busy.example.com/",
      MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.com",
      NODE_ENV: "production",
    };
    expect(mcpAppSandboxOrigins(environment)).toEqual({
      hostOrigin: "https://busy.example.com",
      sandboxOrigin: "https://sandbox.example.com",
    });
    expect(mcpAppSandboxUrl(environment)).toBe(
      "https://sandbox.example.com/mcp-app-sandbox"
    );
    const resourceUrl = new URL(
      mcpAppSandboxUrl(environment, {
        resourceDomains: ["https://cdn.example.com"],
      })
    );
    expect(resourceUrl.origin + resourceUrl.pathname).toBe(
      "https://sandbox.example.com/mcp-app-sandbox"
    );
    expect(resourceUrl.searchParams.get("csp")).toContain(
      "https://cdn.example.com"
    );
  });

  it("permits only the localhost/127.0.0.1 development pair", () => {
    expect(
      mcpAppSandboxOrigins({
        HUB_URL: "http://localhost:3000",
        NODE_ENV: "development",
      })
    ).toEqual({
      hostOrigin: "http://localhost:3000",
      sandboxOrigin: "http://127.0.0.1:3000",
    });
    expect(() =>
      mcpAppSandboxOrigins({
        HUB_URL: "http://dev.example.com:3000",
        NODE_ENV: "development",
      })
    ).toThrow(SANDBOX_ORIGIN_ERROR);
  });
});

describe("MCP App sandbox HTML", () => {
  it("defaults the inner document to a deny-by-default CSP", () => {
    const html = injectMcpAppCsp("<html><body>app</body></html>", undefined);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("object-src 'none'");
    expect(MCP_APP_DEFAULT_CSP).toContain("frame-src 'none'");
  });

  it("keeps only safe CSP origins and does not allow directive injection", () => {
    const csp = mcpAppCsp(
      "default-src *; connect-src 'self' https://api.example.com https://evil.test; " +
        "img-src data: https://cdn.example.com; " +
        "script-src 'unsafe-inline' https://evil.example; connect-src https://a.example;"
    );
    expect(csp).toContain("connect-src https://a.example");
    expect(csp).toContain("img-src data: https://cdn.example.com");
    expect(csp).not.toContain("default-src *");
    expect(csp).not.toContain("evil.example");
    expect(csp).not.toContain("script-src https");
  });

  it("builds standard MCP CSP metadata for every resource class", () => {
    const csp = mcpAppCsp({
      baseUriDomains: ["https://base.example.com"],
      connectDomains: ["https://api.example.com"],
      frameDomains: ["https://frame.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
    expect(csp).toContain("connect-src 'self' https://api.example.com");
    expect(csp).toContain(
      "script-src 'self' https://cdn.example.com 'unsafe-inline'"
    );
    expect(csp).toContain(
      "style-src 'self' https://cdn.example.com 'unsafe-inline'"
    );
    expect(csp).toContain("media-src 'self' https://cdn.example.com");
    expect(csp).toContain("base-uri https://base.example.com");
    expect(csp).toContain("frame-src https://frame.example.com");
  });

  it("escapes a policy before placing it in a meta attribute", () => {
    const html = injectMcpAppCsp(
      "<head></head><body>app</body>",
      'img-src "</meta><script>alert(1)</script>'
    );
    expect(html).not.toContain("</meta>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Content-Security-Policy");
  });

  it("places the policy before commented or forged document tags", () => {
    const html = injectMcpAppCsp(
      '<!-- <head><meta name="fake"> --><script>run()</script>',
      undefined
    );
    const policyIndex = html.indexOf("Content-Security-Policy");
    const commentIndex = html.indexOf("<!--");
    expect(policyIndex).toBeGreaterThanOrEqual(0);
    expect(commentIndex).toBeGreaterThan(policyIndex);
  });

  it("keeps full-document attributes after the CSP-first shell", () => {
    const html = injectMcpAppCsp(
      '<html lang="es" dir="rtl" class="app-shell"><head></head><body data-theme="dark" style="color:red" onload="window.loaded=true"><main>app</main></body></html>',
      undefined
    );
    expect(html).toContain('<html lang="es" dir="rtl" class="app-shell">');
    expect(html).toContain(
      '<body data-theme="dark" style="color:red" onload="window.loaded=true">'
    );
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf('<html lang="es"')
    );
  });

  it("embeds the configured parent origin and never loads a remote proxy script", () => {
    const html = mcpAppSandboxHtml("https://busy.example.com");
    expect(html).toContain("https://busy.example.com");
    expect(html).toContain("event.source === window.parent");
    expect(html).toContain("event.origin === EXPECTED_PARENT_ORIGIN");
    expect(html).toContain("event.origin === 'null'");
    expect(html).toContain("'result' in value || 'error' in value");
    expect(html).toContain("setTimeout(announceReady, 250)");
    expect(html).toContain("allow-scripts allow-forms");
    expect(html).toContain(
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'"
    );
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toMatch(REMOTE_SCRIPT_TAG);
    expect(html).not.toContain("DOMParser");
  });

  it("sets a no-store frame policy for the configured host only", () => {
    const headers = mcpAppSandboxHeaders("https://busy.example.com");
    expect(headers.get("cache-control")).toContain("no-store");
    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors https://busy.example.com"
    );
  });

  it("carries only declared resource origins into the outer CSP ancestor", () => {
    const headers = mcpAppSandboxHeaders("https://busy.example.com", {
      connectDomains: ["https://api.example.com"],
      resourceDomains: ["https://cdn.example.com"],
    });
    const policy = headers.get("content-security-policy");
    expect(policy).toContain(
      "script-src 'self' https://cdn.example.com 'unsafe-inline'"
    );
    expect(policy).toContain(
      "style-src 'self' https://cdn.example.com 'unsafe-inline'"
    );
    expect(policy).not.toContain("api.example.com");
    expect(policy).not.toContain("default-src *");
  });

  it("round-trips resource domains from the sandbox URL into response CSP", () => {
    const environment = {
      HUB_URL: "https://busy.example.com",
      MCP_APP_SANDBOX_ORIGIN: "https://sandbox.example.com",
      NODE_ENV: "production",
    };
    const sandboxUrl = mcpAppSandboxUrl(environment, {
      resourceDomains: ["https://cdn.example.com"],
    });
    const rawCsp = new URL(sandboxUrl).searchParams.get("csp");
    expect(rawCsp).toBeTruthy();
    const response = mcpAppSandboxResponse(
      environment,
      JSON.parse(rawCsp ?? "{}")
    );
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("script-src 'self' https://cdn.example.com");
    expect(policy).toContain("style-src 'self' https://cdn.example.com");
  });
});
