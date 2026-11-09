const MCP_APP_SANDBOX_PATH = "/mcp-app-sandbox";
const DEFAULT_DEV_HUB_ORIGIN = "http://localhost:3000";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);
const SAFE_ORIGIN_PROTOCOLS = new Set(["https:", "http:"]);
const SAFE_CSP_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const SAFE_CSP_HOST = /^(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/iu;
const WHITESPACE = /\s+/u;
const MAX_APP_HTML_LENGTH = 2_000_000;
const MAX_CSP_LENGTH = 8192;
const MAX_CSP_DOMAINS = 64;
const MAX_CSP_DOMAIN_LENGTH = 512;
const MCP_APP_DENY_ALL_PERMISSIONS =
  "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'";

export const MCP_APP_DEFAULT_INNER_SANDBOX = "allow-scripts allow-forms";

/**
 * The sandbox starts closed and receives only the network capabilities named by
 * the MCP App resource. The app HTML is untrusted, so these defaults are also
 * used when a resource omits `_meta.ui.csp`.
 */
export const MCP_APP_DEFAULT_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "media-src 'none'",
  "worker-src 'none'",
].join("; ");

export interface McpAppSandboxOrigins {
  hostOrigin: string;
  sandboxOrigin: string;
}

type Environment = Record<string, string | undefined>;

function originOnly(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`${label} must be an absolute URL`, { cause: error });
  }
  if (
    !SAFE_ORIGIN_PROTOCOLS.has(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} must contain only an HTTP(S) origin`);
  }
  return parsed.origin;
}

function localAlternateOrigin(hostOrigin: string): string {
  const parsed = new URL(hostOrigin);
  if (parsed.protocol !== "http:" || !LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(
      "MCP_APP_SANDBOX_ORIGIN is required outside local HTTP development"
    );
  }
  parsed.hostname = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return parsed.origin;
}

/**
 * Resolve the two origins involved in the double iframe.
 *
 * HUB_URL (or the explicit MCP_APP_HOST_ORIGIN override) is the only trusted
 * parent origin. A request's Host/Origin header and a query-string parent
 * origin are deliberately not used: both are attacker-controlled at a public
 * sandbox route. Local development may use localhost/127.0.0.1 as the two
 * origins without another deployment; production must configure a distinct
 * HTTPS MCP_APP_SANDBOX_ORIGIN.
 */
export function mcpAppSandboxOrigins(
  environment: Environment = process.env
): McpAppSandboxOrigins {
  const production = environment.NODE_ENV === "production";
  const hostValue =
    environment.MCP_APP_HOST_ORIGIN ??
    environment.HUB_URL ??
    (production ? undefined : DEFAULT_DEV_HUB_ORIGIN);
  if (!hostValue) {
    throw new Error("HUB_URL is required for the MCP App sandbox host origin");
  }
  const hostOrigin = originOnly(hostValue, "MCP App host origin");
  const configuredSandbox = environment.MCP_APP_SANDBOX_ORIGIN;
  const sandboxOrigin = originOnly(
    configuredSandbox ?? localAlternateOrigin(hostOrigin),
    "MCP_APP_SANDBOX_ORIGIN"
  );

  if (sandboxOrigin === hostOrigin) {
    throw new Error("MCP App sandbox origin must differ from the host origin");
  }
  if (
    production &&
    (hostOrigin.startsWith("http:") || sandboxOrigin.startsWith("http:"))
  ) {
    throw new Error("MCP App sandbox origins must use HTTPS in production");
  }
  return { hostOrigin, sandboxOrigin };
}

export function mcpAppSandboxUrl(
  environment: Environment = process.env,
  csp?: unknown
): string {
  const url = new URL(
    `${mcpAppSandboxOrigins(environment).sandboxOrigin}${MCP_APP_SANDBOX_PATH}`
  );
  if (csp && typeof csp === "object" && !Array.isArray(csp)) {
    // The outer response only needs resourceDomains. Keep the transport small
    // and validate the values again when they become an HTTP CSP header.
    const resourceDomains = cspOrigins(
      (csp as Record<string, unknown>).resourceDomains
    );
    if (resourceDomains.length > 0) {
      url.searchParams.set("csp", JSON.stringify({ resourceDomains }));
    }
  }
  return url.href;
}

function safeCspOrigin(source: string): string | undefined {
  try {
    const parsed = new URL(source);
    const localHttp = parsed.protocol === "http:" || parsed.protocol === "ws:";
    if (
      !SAFE_CSP_SCHEMES.has(parsed.protocol) ||
      parsed.host.length === 0 ||
      parsed.host === "*" ||
      !SAFE_CSP_HOST.test(parsed.host) ||
      (localHttp && !LOCAL_HOSTS.has(parsed.hostname))
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function cspOrigins(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .slice(0, MAX_CSP_DOMAINS)
        .filter((entry): entry is string => typeof entry === "string")
        .filter((entry) => entry.length <= MAX_CSP_DOMAIN_LENGTH)
        .map(safeCspOrigin)
        .filter((entry): entry is string => typeof entry === "string")
    ),
  ];
}

function standardCsp(value: Record<string, unknown>): string {
  const connect = cspOrigins(value.connectDomains);
  const resources = cspOrigins(value.resourceDomains);
  const frames = cspOrigins(value.frameDomains);
  const base = cspOrigins(value.baseUriDomains);
  const staticSources = ["'self'", ...resources];
  return [
    "default-src 'none'",
    `script-src ${staticSources.join(" ")} 'unsafe-inline'`,
    `style-src ${staticSources.join(" ")} 'unsafe-inline'`,
    `img-src 'self' data: ${resources.join(" ")}`.trim(),
    `font-src 'self' ${resources.join(" ")}`.trim(),
    `media-src 'self' ${resources.join(" ")}`.trim(),
    `connect-src 'self' ${connect.join(" ")}`.trim(),
    `worker-src 'self' ${resources.join(" ")}`.trim(),
    frames.length ? `frame-src ${frames.join(" ")}` : "frame-src 'none'",
    base.length ? `base-uri ${base.join(" ")}` : "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

function cspSource(source: string, directive: string): string | undefined {
  if (source === "'self'") {
    return source;
  }
  if (
    (directive === "img-src" || directive === "font-src") &&
    source === "data:"
  ) {
    return source;
  }
  return safeCspOrigin(source);
}

function policyFromDirectives(input: string): string {
  const directives = new Map<string, string[]>();
  for (const rawDirective of input.split(";")) {
    const tokens = rawDirective.trim().split(WHITESPACE);
    const name = tokens.shift()?.toLowerCase();
    if (!name) {
      continue;
    }
    if (
      ![
        "connect-src",
        "font-src",
        "frame-src",
        "img-src",
        "media-src",
        "script-src",
        "style-src",
        "worker-src",
      ].includes(name)
    ) {
      continue;
    }
    const sources = tokens
      .map((token) => {
        if (
          (name === "script-src" || name === "style-src") &&
          token === "'unsafe-inline'"
        ) {
          return token;
        }
        if (name === "script-src" || name === "style-src") {
          return null;
        }
        return cspSource(token, name);
      })
      .filter((source): source is string => typeof source === "string");
    directives.set(name, [...new Set(sources)]);
  }

  const fallback = new Map<string, string[]>([
    ["default-src", ["'none'"]],
    ["base-uri", ["'none'"]],
    ["form-action", ["'none'"]],
    ["object-src", ["'none'"]],
    ["script-src", ["'unsafe-inline'"]],
    ["style-src", ["'unsafe-inline'"]],
    ["connect-src", ["'none'"]],
    ["img-src", ["'none'"]],
    ["font-src", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["media-src", ["'none'"]],
    ["worker-src", ["'none'"]],
  ]);
  for (const name of [
    "connect-src",
    "font-src",
    "frame-src",
    "img-src",
    "media-src",
    "script-src",
    "style-src",
    "worker-src",
  ]) {
    if (directives.has(name)) {
      fallback.set(name, directives.get(name) ?? []);
    }
  }
  return [...fallback]
    .map(
      ([name, sources]) =>
        `${name} ${sources.length ? sources.join(" ") : "'none'"}`
    )
    .join("; ");
}

/**
 * Normalize the renderer's CSP string and add deny-by-default directives.
 * The renderer already canonicalizes MCP metadata, but the proxy treats the
 * message as untrusted input and never copies arbitrary directive text into a
 * document attribute.
 */
export function mcpAppCsp(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return standardCsp(value as Record<string, unknown>);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CSP_LENGTH
  ) {
    return MCP_APP_DEFAULT_CSP;
  }
  return policyFromDirectives(value);
}

function outerCspSources(policy: string, directive: string): string[] {
  const row = policy
    .split(";")
    .map((part) => part.trim().split(WHITESPACE))
    .find((tokens) => tokens[0] === directive);
  return row && row.length > 1 ? row.slice(1) : ["'unsafe-inline'"];
}

/**
 * The outer proxy is also the CSP ancestor of the `srcdoc` app frame. Include
 * only the resource origins that the app declared, after the same validation
 * used for its inner policy; never copy arbitrary CSP directives here.
 */
function mcpAppOuterCsp(value: unknown, parentOrigin: string): string {
  const policy = mcpAppCsp(value);
  const scripts = outerCspSources(policy, "script-src");
  const styles = outerCspSources(policy, "style-src");
  return [
    `script-src ${scripts.join(" ")}`,
    `style-src ${styles.join(" ")}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${parentOrigin}`,
  ].join("; ");
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Put a trusted document shell before app markup. Do not search untrusted HTML
 * for `<head>`: a comment containing a fake tag can otherwise hide the policy
 * from the parser. The native `srcdoc` parser merges later `<html>`/`<body>`
 * attributes into this trusted shell, preserving full-document app markup.
 */
export function injectMcpAppCsp(html: string, csp: unknown): string {
  const content =
    html.length <= MAX_APP_HTML_LENGTH
      ? html
      : "<!doctype html><title>MCP App resource is too large</title>";
  const policyValue = mcpAppCsp(csp);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policyValue)}">`;
  return `<!doctype html><html><head>${meta}</head><body>${content}</body></html>`;
}

const SANDBOX_PROXY_SCRIPT = String.raw`
      const EXPECTED_PARENT_ORIGIN = __PARENT_ORIGIN__;
      const DEFAULT_CSP = __DEFAULT_CSP__;
      const DEFAULT_INNER_SANDBOX = __DEFAULT_INNER_SANDBOX__;
      const DENY_ALL_PERMISSIONS = __DENY_ALL_PERMISSIONS__;
      const MAX_HTML_LENGTH = 2000000;
      const SAFE_CSP_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
      const SAFE_CSP_HOST = /^(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/iu;
      const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);
      let appFrame;
      let readyTimer;

      if (window.self === window.top || !EXPECTED_PARENT_ORIGIN) {
        throw new Error('MCP App sandbox must run in its configured iframe origin.');
      }
      try {
        if (!document.referrer || new URL(document.referrer).origin !== EXPECTED_PARENT_ORIGIN) {
          throw new Error('MCP App sandbox referrer is not the configured host.');
        }
      } catch {
        throw new Error('MCP App sandbox referrer is not the configured host.');
      }

      function isJsonRpc(value) {
        return value && typeof value === 'object' && !Array.isArray(value) && value.jsonrpc === '2.0' && (typeof value.method === 'string' || 'result' in value || 'error' in value);
      }

      function safeOrigin(source) {
        try {
          const url = new URL(source);
          const localHttp = url.protocol === 'http:' || url.protocol === 'ws:';
          if (!SAFE_CSP_SCHEMES.has(url.protocol) || !url.host || url.host === '*' || !SAFE_CSP_HOST.test(url.host) || (localHttp && !LOCAL_HOSTS.has(url.hostname))) return null;
          return url.origin;
        } catch {
          return null;
        }
      }

      function origins(value) {
        if (!Array.isArray(value)) return [];
        return [...new Set(value.slice(0, 64).filter((entry) => typeof entry === 'string' && entry.length <= 512).map(safeOrigin).filter(Boolean))];
      }

      function standardCsp(value) {
        const connect = origins(value.connectDomains);
        const resources = origins(value.resourceDomains);
        const frames = origins(value.frameDomains);
        const base = origins(value.baseUriDomains);
        const staticSources = ["'self'", ...resources];
        return [
          "default-src 'none'",
          'script-src ' + staticSources.join(' ') + " 'unsafe-inline'",
          'style-src ' + staticSources.join(' ') + " 'unsafe-inline'",
          'img-src \'self\' data: ' + resources.join(' '),
          'font-src \'self\' ' + resources.join(' '),
          'media-src \'self\' ' + resources.join(' '),
          'connect-src \'self\' ' + connect.join(' '),
          'worker-src \'self\' ' + resources.join(' '),
          frames.length ? 'frame-src ' + frames.join(' ') : "frame-src 'none'",
          base.length ? 'base-uri ' + base.join(' ') : "base-uri 'none'",
          "form-action 'none'",
          "object-src 'none'",
        ].join('; ');
      }

      function normalizeCsp(value) {
        if (value && typeof value === 'object' && !Array.isArray(value)) return standardCsp(value);
        if (typeof value !== 'string' || value.length === 0 || value.length > 8192) return DEFAULT_CSP;
        const directives = new Map();
        for (const raw of value.split(';')) {
          const tokens = raw.trim().split(/\s+/u);
          const name = tokens.shift()?.toLowerCase();
          if (!['connect-src', 'font-src', 'frame-src', 'img-src', 'media-src', 'script-src', 'style-src', 'worker-src'].includes(name)) continue;
          const sources = tokens.map((token) => {
            if ((name === 'script-src' || name === 'style-src') && token === "'unsafe-inline'") return token;
            if (name === 'script-src' || name === 'style-src') return null;
            if ((name === 'img-src' || name === 'font-src') && token === 'data:') return token;
            if (token === "'self'") return token;
            return safeOrigin(token);
          }).filter(Boolean);
          directives.set(name, [...new Set(sources)]);
        }
        const policy = new Map([
          ['default-src', ["'none'"]], ['base-uri', ["'none'"]], ['form-action', ["'none'"]], ['object-src', ["'none'"]],
          ['script-src', ["'unsafe-inline'"]], ['style-src', ["'unsafe-inline'"]], ['connect-src', ["'none'"]],
          ['img-src', ["'none'"]], ['font-src', ["'none'"]], ['frame-src', ["'none'"]], ['media-src', ["'none'"]], ['worker-src', ["'none'"]],
        ]);
        for (const name of ['connect-src', 'font-src', 'frame-src', 'img-src', 'media-src', 'script-src', 'style-src', 'worker-src']) {
          if (directives.has(name)) policy.set(name, directives.get(name));
        }
        return [...policy].map(([name, sources]) => name + ' ' + (sources.length ? sources.join(' ') : "'none'")).join('; ');
      }

      function escapeAttribute(value) {
        return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      }

      function injectCsp(html, csp) {
        const content = typeof html === 'string' && html.length <= MAX_HTML_LENGTH ? html : '<!doctype html><title>MCP App resource is too large</title>';
        const policy = normalizeCsp(csp);
        const meta = '<meta http-equiv="Content-Security-Policy" content="' + escapeAttribute(policy) + '">';
        return '<!doctype html><html><head>' + meta + '</head><body>' + content + '</body></html>';
      }

      function safeAllow() {
        return DENY_ALL_PERMISSIONS;
      }

      function createAppFrame(params) {
        if (!params || typeof params !== 'object' || typeof params.html !== 'string') return;
        appFrame?.remove();
        appFrame = document.createElement('iframe');
        // Never accept a server/host override for this attribute. In
        // particular, granting the app's origin would turn srcdoc into the
        // proxy origin and let untrusted HTML reach the host DOM.
        appFrame.sandbox = DEFAULT_INNER_SANDBOX;
        const allow = safeAllow();
        if (allow) appFrame.allow = allow;
        appFrame.srcdoc = injectCsp(params.html, params.csp);
        document.body.appendChild(appFrame);
      }

      window.addEventListener('message', (event) => {
        const data = event.data;
        if (event.source === window.parent && event.origin === EXPECTED_PARENT_ORIGIN) {
          if (isJsonRpc(data) && data.method === 'ui/notifications/sandbox-resource-ready') {
            clearTimeout(readyTimer);
            createAppFrame(data.params);
            return;
          }
          if (isJsonRpc(data) && appFrame?.contentWindow) appFrame.contentWindow.postMessage(data, '*');
          return;
        }
        // The inner frame is deliberately opaque, so its origin is "null".
        if (event.source === appFrame?.contentWindow && event.origin === 'null' && isJsonRpc(data)) {
          window.parent.postMessage(data, EXPECTED_PARENT_ORIGIN);
        }
      });

      function announceReady() {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} }, EXPECTED_PARENT_ORIGIN);
        readyTimer = setTimeout(announceReady, 250);
      }
      announceReady();
`;

/** Render a trusted local outer proxy; MCP App HTML never becomes outer HTML. */
export function mcpAppSandboxHtml(parentOrigin: string): string {
  const trustedParent = originOnly(parentOrigin, "MCP App host origin");
  const script = SANDBOX_PROXY_SCRIPT.replace(
    "__PARENT_ORIGIN__",
    JSON.stringify(trustedParent)
  )
    .replace("__DEFAULT_CSP__", JSON.stringify(MCP_APP_DEFAULT_CSP))
    .replace(
      "__DEFAULT_INNER_SANDBOX__",
      JSON.stringify(MCP_APP_DEFAULT_INNER_SANDBOX)
    )
    .replace(
      "__DENY_ALL_PERMISSIONS__",
      JSON.stringify(MCP_APP_DENY_ALL_PERMISSIONS)
    );
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;background:transparent}body{overflow:hidden}</style></head><body><script>${script}</script></body></html>`;
}

export function mcpAppSandboxHeaders(
  parentOrigin: string,
  csp?: unknown
): Headers {
  const trustedParent = originOnly(parentOrigin, "MCP App host origin");
  return new Headers({
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": mcpAppOuterCsp(csp, trustedParent),
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Content-Type-Options": "nosniff",
  });
}

export function mcpAppSandboxResponse(
  environment: Environment = process.env,
  csp?: unknown
): Response {
  const { hostOrigin } = mcpAppSandboxOrigins(environment);
  return new Response(mcpAppSandboxHtml(hostOrigin), {
    headers: mcpAppSandboxHeaders(hostOrigin, csp),
  });
}
