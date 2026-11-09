import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/** A safe, deliberately small error surface for network policy failures. */
export class McpNetworkError extends Error {
  readonly code:
    | "invalid_url"
    | "private_host"
    | "redirect_limit"
    | "timeout"
    | "fetch_failed";

  constructor(code: McpNetworkError["code"], message: string) {
    super(message);
    this.name = "McpNetworkError";
    this.code = code;
  }
}

export type LookupFn = (
  hostname: string
) => Promise<readonly { address: string }[]>;

export interface NetworkGuardOptions {
  /** HTTP is useful only for local development and is opt-in. */
  allowHttp?: boolean;
  /** Test hook; production uses global fetch. */
  fetchFn?: typeof fetch;
  /** Test hook; production uses the system resolver. */
  lookupFn?: LookupFn;
  /** Maximum number of HTTP redirects to follow. */
  maxRedirects?: number;
  /** Abort a request that does not complete within this many milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_MAX_REDIRECTS = 4;
const DEFAULT_TIMEOUT_MS = 15_000;
const BRACKETED_HOST = /^\[|\]$/gu;
const TRAILING_DOT = /\.$/u;
const HEX_GROUP = /^[0-9a-f]{1,4}$/iu;

function normalizedHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(BRACKETED_HOST, "")
    .replace(TRAILING_DOT, "");
}

function parseUrl(raw: string | URL): URL {
  try {
    return new URL(raw);
  } catch {
    // biome-ignore lint/style/useErrorCause: Network parsing errors intentionally expose only a stable public code.
    throw new McpNetworkError("invalid_url", "MCP endpoint URL is invalid");
  }
}

/**
 * Reject loopback, link-local, private, multicast and otherwise reserved IPs.
 * IPv4-mapped IPv6 literals are reduced to IPv4 before checking.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Security classification must cover every reserved IPv4/IPv6 range in one predicate.
export function isPrivateIp(raw: string): boolean {
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice("::ffff:".length);
  }

  if (net.isIPv4(ip)) {
    const octets = ip.split(".").map(Number);
    const [a, b] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // shared carrier NAT
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224
    );
  }

  if (net.isIPv6(ip)) {
    // Detect mapped/compatible IPv4 addresses after expanding all equivalent
    // spellings, e.g. `0:0:0:0:0:ffff:7f00:1`.
    const parts = ipv6Parts(ip);
    if (parts !== null) {
      const prefix96 = parts.slice(0, 6);
      if (prefix96.every((part) => part === 0)) {
        return true;
      }
      if (
        prefix96.slice(0, 5).every((part) => part === 0) &&
        prefix96[5] === 0xff_ff
      ) {
        const [, , , , , , high, low] = parts;
        if (high === undefined || low === undefined) {
          return false;
        }
        const v4 = high * 65_536 + low;
        return isPrivateIp(
          // biome-ignore lint/suspicious/noBitwiseOperators: IPv4-mapped IPv6 conversion requires 32-bit shifts and masks.
          `${v4 >>> 24}.${(v4 >>> 16) & 255}.${(v4 >>> 8) & 255}.${v4 & 255}`
        );
      }
    }
    return (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      ip.startsWith("fe80") ||
      ip.startsWith("fec0") ||
      ip.startsWith("ff")
    );
  }

  // An unrecognised address must not become a server-side request target.
  return true;
}

/** Expand an IPv6 spelling so mapped forms cannot bypass checks. */
function ipv6Parts(raw: string): number[] | null {
  const halves = raw.split("::");
  if (halves.length > 2) {
    return null;
  }
  const expand = (part: string): string[] => {
    if (!part) {
      return [];
    }
    const pieces = part.split(":");
    const result: string[] = [];
    for (const piece of pieces) {
      if (piece.includes(".")) {
        const octets = piece.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some(
            (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
          )
        ) {
          return [];
        }
        result.push(
          // biome-ignore lint/suspicious/noBitwiseOperators: IPv6 normalization packs octets into 16-bit words.
          ((octets[0] << 8) | octets[1]).toString(16),
          // biome-ignore lint/suspicious/noBitwiseOperators: IPv6 normalization packs octets into 16-bit words.
          ((octets[2] << 8) | octets[3]).toString(16)
        );
      } else {
        result.push(piece);
      }
    }
    return result;
  };
  const left = expand(halves[0] ?? "");
  const right = expand(halves[1] ?? "");
  if (!(left.length || right.length) && raw !== "::") {
    return null;
  }
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const pieces = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (pieces.length !== 8 || pieces.some((piece) => !HEX_GROUP.test(piece))) {
    return null;
  }
  return pieces.map((piece) => Number.parseInt(piece, 16));
}

function ensureUrl(raw: string | URL, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // biome-ignore lint/style/useErrorCause: Network parsing errors intentionally expose only a stable public code.
    throw new McpNetworkError("invalid_url", "MCP endpoint URL is invalid");
  }

  const protocolAllowed =
    url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  if (!protocolAllowed || url.username || url.password || !url.hostname) {
    throw new McpNetworkError("invalid_url", "MCP endpoint URL is not allowed");
  }

  const host = normalizedHost(url);
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa")
  ) {
    throw new McpNetworkError("private_host", "MCP endpoint host is private");
  }

  if (net.isIP(host) && isPrivateIp(host)) {
    throw new McpNetworkError("private_host", "MCP endpoint host is private");
  }
  return url;
}

async function resolveAndValidate(
  url: URL,
  options: NetworkGuardOptions
): Promise<URL> {
  const checked = ensureUrl(url, options.allowHttp ?? false);
  const host = normalizedHost(checked);
  if (net.isIP(host)) {
    return checked;
  }

  const lookup =
    options.lookupFn ??
    (async (hostname: string) =>
      dnsLookup(hostname, { all: true, verbatim: true }));
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookup(host);
  } catch {
    // biome-ignore lint/style/useErrorCause: DNS details are deliberately hidden from the public network error.
    throw new McpNetworkError(
      "private_host",
      "MCP endpoint host could not be validated"
    );
  }
  if (
    !addresses.length ||
    addresses.some(({ address }) => isPrivateIp(address))
  ) {
    throw new McpNetworkError("private_host", "MCP endpoint host is private");
  }
  return checked;
}

/**
 * Validate an endpoint before any request is made. This is async because DNS
 * answers are part of the policy; use `assertPublicHttpUrlSync` only in SDK
 * hooks that cannot await and always perform this async check at request start.
 */
export async function assertPublicHttpUrl(
  raw: string | URL,
  options: NetworkGuardOptions = {}
): Promise<URL> {
  return await resolveAndValidate(parseUrl(raw), options);
}

/** Structural validation for synchronous OAuth SDK callbacks. */
export function assertPublicHttpUrlSync(
  raw: string | URL,
  options: Pick<NetworkGuardOptions, "allowHttp"> = {}
): URL {
  return ensureUrl(parseUrl(raw), options.allowHttp ?? false);
}

function combinedSignal(
  signal: AbortSignal | null | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort(signal.reason);
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  return {
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    },
    signal: controller.signal,
  };
}

function redirectRequest(
  init: RequestInit,
  status: number,
  from: URL,
  to: URL
): RequestInit {
  const method = (init.method ?? "GET").toUpperCase();
  if (from.origin !== to.origin && method !== "GET" && method !== "HEAD") {
    // OAuth token/code exchanges carry secrets in their POST body. Do not
    // follow a cross-origin redirect even after stripping request headers.
    throw new McpNetworkError(
      "invalid_url",
      "MCP endpoint cross-origin redirect is not allowed"
    );
  }
  const headers = new Headers(init.headers);
  // Never forward bearer/basic/cookie credentials to a different origin.
  if (from.origin !== to.origin) {
    headers.delete("authorization");
    headers.delete("cookie");
    headers.delete("proxy-authorization");
  }

  if (
    (status === 301 || status === 302 || status === 303) &&
    method !== "GET" &&
    method !== "HEAD"
  ) {
    headers.delete("content-length");
    headers.delete("content-type");
    return { ...init, body: undefined, headers, method: "GET" };
  }
  return { ...init, headers };
}

/**
 * Fetch through an explicit redirect loop. The native fetch redirect handling
 * is disabled so every hop gets DNS/private-address validation and a timeout.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Redirect, DNS, timeout, and credential policies are intentionally enforced in one loop.
export async function guardedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: NetworkGuardOptions = {}
): Promise<Response> {
  const fetchFn = options.fetchFn ?? fetch;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let url = await resolveAndValidate(
    input instanceof Request ? parseUrl(input.url) : parseUrl(input),
    options
  );
  let requestInit: RequestInit = { ...init };
  if (input instanceof Request) {
    requestInit = {
      body: input.body,
      headers: new Headers(input.headers),
      method: input.method,
      ...requestInit,
    };
  }

  for (let redirects = 0; ; redirects += 1) {
    const { signal, cleanup } = combinedSignal(requestInit.signal, timeoutMs);
    try {
      if (signal.aborted) {
        throw new McpNetworkError("timeout", "MCP endpoint request timed out");
      }
      // biome-ignore lint/performance/noAwaitInLoops: Redirects must be validated and followed one at a time.
      const response = await fetchFn(url, {
        ...requestInit,
        redirect: "manual",
        signal,
      });
      if (response.status < 300 || response.status >= 400) {
        return response;
      }
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      if (redirects >= maxRedirects) {
        throw new McpNetworkError(
          "redirect_limit",
          "MCP endpoint redirected too many times"
        );
      }
      const nextUrl = await resolveAndValidate(new URL(location, url), options);
      requestInit = redirectRequest(requestInit, response.status, url, nextUrl);
      url = nextUrl;
    } catch (error) {
      if (error instanceof McpNetworkError) {
        throw error;
      }
      if (
        signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        // biome-ignore lint/style/useErrorCause: The public error intentionally omits request and URL details.
        throw new McpNetworkError("timeout", "MCP endpoint request timed out");
      }
      // biome-ignore lint/style/useErrorCause: The public error intentionally omits provider response details.
      throw new McpNetworkError("fetch_failed", "MCP endpoint request failed");
    } finally {
      cleanup();
    }
  }
}
