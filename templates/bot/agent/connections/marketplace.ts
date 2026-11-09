import { getVercelOidcToken } from "@vercel/oidc";
import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import {
  approvalPrompt,
  currentMarketplaceToolPolicy,
  type marketplaceToolPolicy,
} from "../lib/approval";
import { isConsultation } from "../lib/caller";
import { firesideHeaders, firesideIdentity } from "../lib/fireside";
import { type HubFetch, hubFetch } from "../lib/hub";

const MARKETPLACE_PATH = "/api/bot/mcp";
const PROXY_PATH = "/api/bot/mcp";
const TRAILING_SLASH = /\/$/u;
const EVE_CONNECTION_NAME_MAX_LENGTH = 64;
const CATALOG_ID_SANITIZE_RE = /[^a-z0-9]+/gu;
const CATALOG_ID_EDGE_RE = /^-+|-+$/gu;
const TRAILING_DASH_RE = /-+$/u;

type MarketplaceAuth = "oauth" | "none";
type MarketplaceTransport = "http" | "sse";
type MarketplaceToolVisibility = "model" | "app";

interface MarketplaceToolUi {
  resourceUri?: string;
  visibility?: MarketplaceToolVisibility[];
}

export interface MarketplaceTool {
  description: string;
  destructiveHint?: boolean;
  name: string;
  readOnlyHint: boolean;
  ui?: MarketplaceToolUi;
}

export interface MarketplaceConnection {
  aclMode?: "enforced" | "legacy";
  allowedTools?: string[];
  auth: MarketplaceAuth;
  catalogHash?: string;
  catalogId: string;
  catalogVersion?: string;
  description: string;
  id: string;
  lifecycle?: "active" | "deprecated" | "update" | "removed";
  name: string;
  tools?: MarketplaceTool[];
  transport: MarketplaceTransport;
  url: string;
}

interface TokenResponse {
  expiresAt?: unknown;
  token: unknown;
}

/**
 * Keep the hub response as data. No OAuth material is returned from this
 * function: the token broker is called only when eve is about to invoke a
 * protected MCP tool.
 */
export async function listMarketplaceConnections(
  fetcher: HubFetch = hubFetch
): Promise<MarketplaceConnection[]> {
  let response: Response;
  try {
    response = await fetcher(MARKETPLACE_PATH);
  } catch (error) {
    throw new Error("MCP marketplace is unavailable", { cause: error });
  }
  if (!response.ok) {
    throw new Error(`MCP marketplace is unavailable (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new Error("MCP marketplace returned an invalid response", {
      cause: error,
    });
  }
  return parseMarketplaceResponse(body);
}

/**
 * Resolve the current connection set on every model call. Deliberately no
 * ctx.memo: adding or revoking a marketplace entry must take effect in an
 * existing Eve session on its next model call.
 *
 * A read-only consultation gets no MCP connection at all: even a "read" sends
 * its arguments to a third party. The approval policy denies a call replayed
 * from an earlier step too (lib/approval.ts), so discovery and execution agree.
 */
export async function resolveMarketplaceConnections(
  fetcher: HubFetch = hubFetch,
  consultation = false
) {
  const result: Record<
    string,
    ReturnType<typeof defineMcpClientConnection>
  > = {};
  if (consultation) {
    return result;
  }
  const connections = await listMarketplaceConnections(fetcher);
  const baseNameCounts = new Map<string, number>();
  for (const connection of connections) {
    const baseName = connectionName(connection.catalogId);
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const usedNames = new Set<string>();
  for (const connection of connections) {
    const baseName = connectionName(connection.catalogId);
    let name = baseName;
    if ((baseNameCounts.get(baseName) ?? 0) > 1 || usedNames.has(name)) {
      name = uniqueConnectionName(baseName, connection.id);
      for (let disambiguator = 2; usedNames.has(name); disambiguator += 1) {
        name = uniqueConnectionName(baseName, connection.id, disambiguator);
      }
    }
    usedNames.add(name);

    // Eve autodetects Streamable HTTP vs SSE from the endpoint. `transport` is
    // still validated above so the hub cannot silently publish a new protocol.
    const reviewedTools = connection.tools ?? [];
    const legacy = connection.aclMode === "legacy";
    const allowedTools = allowedToolNames(connection, reviewedTools, legacy);
    const useProxy =
      !legacy && reviewedTools.some((tool) => Boolean(tool.ui?.resourceUri));
    const definition = {
      // The allowlist is both a discovery filter and a runtime denial policy.
      // The latter protects calls replayed from an older session history.
      approval: {
        prompt: approvalPrompt,
        request: (ctx: Parameters<typeof marketplaceToolPolicy>[1]) =>
          currentMarketplaceToolPolicy(
            connection.id,
            legacy ? null : allowedTools,
            ctx,
            fetcher
          ),
      },
      description: `${connection.name}: ${connection.description}`,
      instanceKey: connection.id,
      ...(legacy ? {} : { tools: { allow: allowedTools } }),
      url: useProxy ? proxyUrl(connection.id) : connection.url,
      ...connectionAuth(connection, fetcher, useProxy),
    };

    result[name] = defineMcpClientConnection(definition);
  }

  return result;
}

export default defineDynamic(async (ctx) =>
  resolveMarketplaceConnections(hubFetch, isConsultation(ctx.session.auth))
);

function connectionName(catalogId: string): string {
  const safe = normalizeNameSegment(catalogId);
  return `mcp-${safe}`
    .slice(0, EVE_CONNECTION_NAME_MAX_LENGTH)
    .replace(TRAILING_DASH_RE, "");
}

function uniqueConnectionName(
  baseName: string,
  connectionId: string,
  disambiguator?: number
): string {
  const suffix = normalizeNameSegment(connectionId);
  const suffixTail = disambiguator === undefined ? "" : `-${disambiguator}`;
  const suffixHead = suffix
    .slice(0, Math.max(0, 32 - suffixTail.length))
    .replace(TRAILING_DASH_RE, "");
  const uniqueSuffix = `${suffixHead}${suffixTail}`;
  const baseLength = EVE_CONNECTION_NAME_MAX_LENGTH - uniqueSuffix.length - 1;
  const base = baseName.slice(0, baseLength).replace(TRAILING_DASH_RE, "");
  return `${base || "mcp"}-${uniqueSuffix || "connection"}`;
}

function normalizeNameSegment(value: string): string {
  const safe = value
    .trim()
    .toLowerCase()
    .replace(CATALOG_ID_SANITIZE_RE, "-")
    .replace(CATALOG_ID_EDGE_RE, "");
  return safe || "connection";
}

function allowedToolNames(
  connection: MarketplaceConnection,
  reviewedTools: readonly MarketplaceTool[],
  legacy: boolean
): string[] {
  if (legacy) {
    return [];
  }
  const configured =
    connection.allowedTools ??
    reviewedTools
      .filter(
        (tool) =>
          isModelVisible(tool.ui) && tool.readOnlyHint && !tool.destructiveHint
      )
      .map((tool) => tool.name);
  if (reviewedTools.length === 0) {
    return configured;
  }
  const visibleNames = new Set(
    reviewedTools
      .filter((tool) => isModelVisible(tool.ui))
      .map((tool) => tool.name)
  );
  return configured.filter((tool) => visibleNames.has(tool));
}

function isModelVisible(ui?: MarketplaceToolUi): boolean {
  return ui?.visibility === undefined || ui.visibility.includes("model");
}

function connectionAuth(
  connection: MarketplaceConnection,
  fetcher: HubFetch,
  useProxy: boolean
) {
  if (useProxy) {
    return {
      auth: {
        getToken: async () => {
          const token = await getVercelOidcToken();
          return {
            expiresAt: oidcExpiresAt(token),
            token,
          };
        },
        principalType: "app" as const,
      },
      headers: (ctx: Parameters<typeof firesideIdentity>[0]) => {
        const identity = firesideIdentity(ctx);
        return identity ? firesideHeaders(identity) : {};
      },
      toolCall: {
        providedArguments: {
          __busy: ({
            callId,
            session,
            toolName,
          }: {
            callId: string;
            session: { id: string };
            toolName: string;
          }) => ({
            callId,
            connectionId: connection.id,
            sessionId: session.id,
            toolName,
            ...(connection.tools?.find((tool) => tool.name === toolName)?.ui
              ?.resourceUri
              ? {
                  resourceUri: connection.tools.find(
                    (tool) => tool.name === toolName
                  )?.ui?.resourceUri,
                }
              : {}),
          }),
        },
      },
    };
  }
  if (connection.auth === "oauth") {
    return {
      auth: {
        getToken: async () => getMarketplaceToken(connection, fetcher),
        principalType: "app" as const,
      },
    };
  }
  return {};
}

function proxyUrl(connectionId: string): string {
  const hub = process.env.HUB_URL?.replace(TRAILING_SLASH, "");
  if (!hub) {
    throw new Error("HUB_URL is required for MCP App connections.");
  }
  return `${hub}${PROXY_PATH}/${encodeURIComponent(connectionId)}/proxy`;
}

function oidcExpiresAt(token: string): number {
  const fallback = Date.now() + 60_000;
  const [, payload] = token.split(".");
  if (!payload) {
    return fallback;
  }
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = globalThis.atob(
      normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    );
    const { exp } = JSON.parse(decoded) as { exp?: unknown };
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
      return Math.min(exp * 1000, fallback);
    }
  } catch {
    // Refresh conservatively when the token's public expiry cannot be read.
  }
  return fallback;
}

function parseMarketplaceResponse(body: unknown): MarketplaceConnection[] {
  if (!(isRecord(body) && Array.isArray(body.connections))) {
    throw new Error("MCP marketplace returned an invalid response");
  }
  return body.connections.map((value, index) =>
    parseMarketplaceConnection(value, index)
  );
}

function parseMarketplaceConnection(
  value: unknown,
  index: number
): MarketplaceConnection {
  if (!isRecord(value)) {
    throw invalidMarketplaceConnection(index);
  }
  const id = stringField(value.id);
  const name = stringField(value.name);
  const description = stringField(value.description);
  const url = stringField(value.url);
  const catalogId = stringField(value.catalogId);
  const { auth, transport } = value;
  if (!(id && name && description && catalogId && isHttpUrl(url))) {
    throw invalidMarketplaceConnection(index);
  }
  if (!(isMarketplaceAuth(auth) && isMarketplaceTransport(transport))) {
    throw invalidMarketplaceConnection(index);
  }
  const allowedTools = stringList(value.allowedTools);
  const tools = parseTools(value.tools);
  return {
    aclMode:
      value.aclMode === "enforced" || value.aclMode === "legacy"
        ? value.aclMode
        : undefined,
    allowedTools,
    auth,
    catalogHash: stringField(value.catalogHash) || undefined,
    catalogId,
    catalogVersion: stringField(value.catalogVersion) || undefined,
    description,
    id,
    lifecycle: lifecycle(value.lifecycle),
    name,
    tools,
    transport,
    url,
  };
}

function invalidMarketplaceConnection(index: number): Error {
  return new Error(
    `MCP marketplace returned an invalid connection at index ${index}`
  );
}

function isMarketplaceAuth(value: unknown): value is MarketplaceAuth {
  return value === "oauth" || value === "none";
}

function isMarketplaceTransport(value: unknown): value is MarketplaceTransport {
  return value === "http" || value === "sse";
}

function lifecycle(
  value: unknown
): MarketplaceConnection["lifecycle"] | undefined {
  return value === "active" ||
    value === "deprecated" ||
    value === "update" ||
    value === "removed"
    ? value
    : undefined;
}

async function getMarketplaceToken(
  connection: MarketplaceConnection,
  fetcher: HubFetch
) {
  let response: Response;
  try {
    response = await fetcher(
      `${MARKETPLACE_PATH}/${encodeURIComponent(connection.id)}/token`
    );
  } catch (error) {
    throw new Error(`MCP authorization is unavailable for ${connection.name}`, {
      cause: error,
    });
  }
  if (response.status === 404 || response.status === 409) {
    throw new Error(`MCP authorization is required for ${connection.name}`);
  }
  if (!response.ok) {
    throw new Error(`MCP authorization is unavailable for ${connection.name}`);
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch (error) {
    throw new Error(
      `MCP authorization returned an invalid token for ${connection.name}`,
      { cause: error }
    );
  }
  if (
    !isRecord(body) ||
    typeof body.token !== "string" ||
    body.token.length === 0
  ) {
    throw new Error(
      `MCP authorization returned an invalid token for ${connection.name}`
    );
  }
  const tokenResponse = body as unknown as TokenResponse;
  if (
    tokenResponse.expiresAt !== undefined &&
    (typeof tokenResponse.expiresAt !== "number" ||
      !Number.isFinite(tokenResponse.expiresAt))
  ) {
    throw new Error(
      `MCP authorization returned an invalid token for ${connection.name}`
    );
  }
  return tokenResponse.expiresAt === undefined
    ? { token: body.token }
    : { expiresAt: tokenResponse.expiresAt, token: body.token };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const names = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return names.length === value.length ? [...new Set(names)] : undefined;
}

function parseTools(value: unknown): MarketplaceTool[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const tools = value.flatMap((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      typeof item.description !== "string" ||
      typeof item.readOnlyHint !== "boolean"
    ) {
      return [];
    }
    const ui = parseToolUi(item.ui);
    return [
      {
        description: item.description,
        ...(typeof item.destructiveHint === "boolean"
          ? { destructiveHint: item.destructiveHint }
          : {}),
        name: item.name,
        readOnlyHint: item.readOnlyHint,
        ...(ui ? { ui } : {}),
      },
    ];
  });
  return tools.length === value.length ? tools : undefined;
}

function parseToolUi(value: unknown): MarketplaceToolUi | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const resourceUri =
    typeof value.resourceUri === "string" &&
    value.resourceUri.startsWith("ui://") &&
    value.resourceUri.length <= 2048
      ? value.resourceUri
      : undefined;
  const visibility = Array.isArray(value.visibility)
    ? value.visibility.filter(
        (item): item is MarketplaceToolVisibility =>
          item === "model" || item === "app"
      )
    : undefined;
  if (!(resourceUri || visibility)) {
    return undefined;
  }
  return {
    ...(resourceUri ? { resourceUri } : {}),
    ...(visibility ? { visibility: [...new Set(visibility)] } : {}),
  };
}
