import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  type CallToolResult,
  createMCPClient,
  type ListToolsResult,
  type MCPAppResource,
  type MCPClient,
  mcpAppClientCapabilities,
  readMCPAppResource,
} from "@ai-sdk/mcp";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getBot } from "../bots/service";
import { db, events, type McpConnectionRow } from "../db";
import { need } from "../env";
import { getMcpAppResultForCall } from "./app-results";
import { mcpAppSandboxUrl as configuredMcpAppSandboxUrl } from "./app-sandbox";
import { catalogEntry } from "./catalog";
import { assertPublicHttpUrl, guardedFetch } from "./network";
import { freshToken, McpOAuthProvider, McpReconnectError } from "./oauth";
import { getProviderClient } from "./provider-clients";
import { freshRegisteredToken } from "./registered-oauth";
import { connectionRuntimeState, withConnection } from "./store";
import {
  isAppVisible,
  isModelVisible,
  mcpAppSnapshotId,
  toolUiMetadata,
} from "./tool-ui";

const APPROVAL_TTL_MS = 2 * 60_000;
const MAX_ACTIVE_APPROVAL_RECEIPTS = 100;
const MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const MCP_CONNECTION_SEPARATOR = "__";

type JsonRecord = Record<string, unknown>;

interface StoredCallEvent {
  data: unknown;
  index: number;
  line: number;
}

export interface McpAppCallContext {
  botId: string;
  botSlug: string;
  callId: string;
  connectionId: string;
  input: JsonRecord;
  result: unknown;
  sessionId: string;
  snapshotId?: string;
  snapshotVerified: boolean;
  toolName: string;
}

export interface McpAppDescriptor {
  connectionId: string;
  input: JsonRecord;
  resourceUri: string;
  result: unknown;
  title?: string;
  toolName: string;
}

export interface McpAppResourceResponse {
  allowedTools: string[];
  app: McpAppDescriptor;
  resource: MCPAppResource;
  sandboxUrl: string;
}

export class McpAppBridgeError extends Error {
  readonly code:
    | "approval_required"
    | "connection_unavailable"
    | "invalid_request"
    | "not_found"
    | "resource_too_large"
    | "tool_not_allowed"
    | "unauthorized";
  readonly status: number;

  constructor(
    code: McpAppBridgeError["code"],
    message: string,
    status: number,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.name = "McpAppBridgeError";
    this.status = status;
  }
}

export class McpAppApprovalRequiredError extends McpAppBridgeError {
  readonly approval: string;
  readonly argumentsHash: string;
  readonly descriptorHash: string;
  readonly expiresAt: number;
  readonly nameForApproval: string;

  constructor(
    approval: string,
    argsHash: string,
    descriptorHash: string,
    expiresAt: number,
    name: string
  ) {
    super(
      "approval_required",
      "This MCP App action needs explicit user approval.",
      409
    );
    this.approval = approval;
    this.argumentsHash = argsHash;
    this.descriptorHash = descriptorHash;
    this.expiresAt = expiresAt;
    this.nameForApproval = name;
  }
}

interface ResolvedConnection {
  entry: NonNullable<ReturnType<typeof catalogEntry>>;
  row: McpConnectionRow;
  state: Awaited<ReturnType<typeof connectionRuntimeState>>;
}

export interface McpOpenClient {
  client: MCPClient;
  data: Record<string, unknown>;
  provider?: McpOAuthProvider;
  resolved: ResolvedConnection;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventData(event: StoredCallEvent): JsonRecord {
  return isRecord(event.data) && isRecord(event.data.data)
    ? event.data.data
    : {};
}

function capabilityOf(data: JsonRecord): JsonRecord {
  return isRecord(data.capability) ? data.capability : {};
}

function firstString(
  record: JsonRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function toolNameOf(data: JsonRecord): string | undefined {
  const capability = capabilityOf(data);
  return (
    firstString(capability, "name", "toolName") ??
    firstString(data, "toolName", "name")
  );
}

function remoteToolName(toolName: string): string {
  const separator = toolName.lastIndexOf(MCP_CONNECTION_SEPARATOR);
  return separator === -1 ? toolName : toolName.slice(separator + 2);
}

function inputOf(data: JsonRecord): JsonRecord {
  return isRecord(data.input) ? data.input : {};
}

function resultOf(event: StoredCallEvent | undefined): unknown {
  if (!event) {
    return null;
  }
  const data = eventData(event);
  return data.output ?? data.result ?? data.error ?? null;
}

async function currentBotCall(
  botSlug: string,
  callId: string
): Promise<McpAppCallContext | null> {
  const bot = await getBot(botSlug);
  if (!bot?.sessionId) {
    return null;
  }
  const [requested] = await db()
    .select({ data: events.data, index: events.index, line: events.line })
    .from(events)
    .where(
      and(
        eq(events.sessionId, bot.sessionId),
        eq(events.botId, bot.id),
        eq(events.type, "call.requested"),
        sql`${events.data}->'data'->>'callId' = ${callId}`
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(1);
  if (!requested) {
    return null;
  }
  const requestEvent = requested as StoredCallEvent;
  const data = eventData(requestEvent);
  const toolName = toolNameOf(data);
  if (!toolName) {
    return null;
  }
  const [settled] = await db()
    .select({ data: events.data, index: events.index, line: events.line })
    .from(events)
    .where(
      and(
        eq(events.sessionId, bot.sessionId),
        eq(events.botId, bot.id),
        eq(events.type, "call.settled"),
        sql`${events.data}->'data'->>'callId' = ${callId}`
      )
    )
    .orderBy(asc(events.line), asc(events.index))
    .limit(1);
  // SSE forwards the result before its ordered database save finishes. Treat
  // this short gap as pending so the host can retry the original call id.
  if (!settled) {
    return null;
  }
  return verifiedMcpAppCall(
    botSlug,
    bot.id,
    bot.sessionId,
    callId,
    requestEvent,
    settled as StoredCallEvent
  );
}

export async function verifiedMcpAppCall(
  botSlug: string,
  botId: string,
  sessionId: string,
  callId: string,
  requested: StoredCallEvent,
  settled: StoredCallEvent
): Promise<McpAppCallContext | null> {
  const data = eventData(requested);
  const toolName = toolNameOf(data);
  if (!toolName) {
    return null;
  }
  const rawResult = resultOf(settled as StoredCallEvent | undefined);
  const snapshotId = mcpAppSnapshotId(rawResult);
  if (!snapshotId) {
    return null;
  }
  const snapshot = await getMcpAppResultForCall(snapshotId, {
    botId,
    callId,
    sessionId,
  }).catch(() => null);
  if (
    !(
      snapshot &&
      (snapshot.toolName === remoteToolName(toolName) ||
        snapshot.toolName === toolName)
    ) ||
    canonicalJson(snapshot.input) !== canonicalJson(inputOf(data))
  ) {
    return null;
  }
  return {
    botId,
    botSlug,
    callId,
    connectionId: snapshot.connectionId,
    input: snapshot.input,
    result: snapshot.result,
    sessionId,
    snapshotId,
    snapshotVerified: true,
    toolName,
  };
}

function connectionFailure(message: string): McpAppBridgeError {
  return new McpAppBridgeError("connection_unavailable", message, 409);
}

async function resolveConnection(
  row: McpConnectionRow
): Promise<ResolvedConnection> {
  const entry = catalogEntry(row.catalogId);
  const state = await connectionRuntimeState(row);
  if (
    !entry ||
    row.status !== "connected" ||
    state.aclMode !== "enforced" ||
    state.lifecycle !== "active" ||
    state.reauthRequired
  ) {
    throw connectionFailure("This MCP connection is no longer available.");
  }
  return { entry, row, state };
}

async function openClient(
  row: McpConnectionRow,
  data: Record<string, unknown>
): Promise<McpOpenClient> {
  const resolved = await resolveConnection(row);
  await assertPublicHttpUrl(resolved.entry.url);
  let nextData = data;
  let provider: McpOAuthProvider | undefined;
  const headers: Record<string, string> = {};
  if (resolved.entry.auth === "oauth") {
    if (!stringValue(data.redirectOrigin)) {
      throw connectionFailure("Reconnect this MCP before using its app.");
    }
    provider = new McpOAuthProvider(data, {
      connectionId: row.id,
      origin: String(data.redirectOrigin),
      scope: resolved.entry.oauthScopes,
    });
    const registeredProvider = resolved.entry.oauthProvider;
    let token: { expiresAt?: number; token: string };
    try {
      token = registeredProvider
        ? await (async () => {
            const providerClient = await getProviderClient(registeredProvider);
            if (
              !providerClient ||
              providerClient.version !== data.registeredClientVersion
            ) {
              throw new McpReconnectError();
            }
            return await freshRegisteredToken(
              provider,
              registeredProvider,
              Date.now()
            );
          })()
        : await freshToken(provider, resolved.entry.url, Date.now(), {
            scope: resolved.entry.oauthScopes,
          });
    } catch (error) {
      if (error instanceof McpReconnectError) {
        provider.invalidateCredentials("tokens");
      }
      for (const key of Object.keys(data)) {
        delete data[key];
      }
      Object.assign(data, provider.data);
      throw error;
    }
    for (const key of Object.keys(data)) {
      delete data[key];
    }
    Object.assign(data, provider.data);
    nextData = data;
    headers.authorization = `Bearer ${token.token}`;
  }
  const client = await createMCPClient({
    capabilities: mcpAppClientCapabilities,
    clientName: "BUSY MCP Apps Host",
    maxRetries: 0,
    protocolVersionDiscovery: true,
    transport: {
      ...(Object.keys(headers).length ? { headers } : {}),
      fetch: (input, init) => guardedFetch(input, init),
      type: resolved.entry.transport,
      url: resolved.entry.url,
    },
    version: "1.0.0",
  });
  return { client, data: nextData, provider, resolved };
}

export async function withMcpConnectionClient<T>(
  connectionId: string,
  run: (open: McpOpenClient) => Promise<T>
): Promise<T> {
  const value = await withConnection<
    { error: unknown; ok: false } | { ok: true; value: T }
  >(connectionId, async (row, data) => {
    let open: McpOpenClient | undefined;
    try {
      open = await openClient(row, data as Record<string, unknown>);
      return { data: open.data, value: { ok: true, value: await run(open) } };
    } catch (error) {
      const reconnect = error instanceof McpReconnectError;
      return {
        data: open?.data ?? (data as Record<string, unknown>),
        ...(reconnect
          ? {
              error:
                "Authorization expired or was revoked. Reconnect this MCP.",
              status: "error" as const,
            }
          : {}),
        value: { error, ok: false },
      };
    } finally {
      await open?.client.close().catch(() => undefined);
    }
  });
  if (value === null) {
    throw new McpAppBridgeError("not_found", "MCP connection not found.", 404);
  }
  if (!value.ok) {
    throw value.error;
  }
  return value.value;
}

async function withAppClient<T>(
  context: McpAppCallContext,
  run: (open: McpOpenClient) => Promise<T>
): Promise<T> {
  return await withMcpConnectionClient(context.connectionId, run);
}

async function listTools(client: MCPClient) {
  const pages: ListToolsResult[] = [];
  let cursor: string | undefined;
  do {
    // biome-ignore lint/performance/noAwaitInLoops: MCP pagination is cursor-ordered.
    const page = await client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
    });
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return {
    ...pages.at(-1),
    tools: pages.flatMap((page) => page.tools),
  };
}

function assertAllowed(state: ResolvedConnection["state"], name: string): void {
  if (!(state.allowedTools ?? []).includes(name)) {
    throw new McpAppBridgeError(
      "tool_not_allowed",
      "This MCP tool is not enabled for the current connection.",
      403
    );
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function toolDescriptorHash(
  tool: {
    _meta?: unknown;
    annotations?: unknown;
    inputSchema?: unknown;
    name: string;
  },
  state: ResolvedConnection["state"]
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        allowedTools: state.allowedTools ?? [],
        annotations: tool.annotations ?? null,
        catalogHash: state.catalogHash ?? null,
        catalogVersion: state.catalogVersion ?? null,
        inputSchema: tool.inputSchema ?? null,
        name: tool.name,
        ui: toolUiMetadata(tool._meta) ?? null,
      })
    )
    .digest("hex");
}

export function argumentsHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function approvalPayload(
  botId: string,
  callId: string,
  connectionId: string,
  descriptorHash: string,
  name: string,
  hash: string,
  expiresAt: number,
  sessionId: string,
  nonce: string
): string {
  return JSON.stringify({
    botId,
    callId,
    connectionId,
    descriptorHash,
    expiresAt,
    hash,
    name,
    nonce,
    sessionId,
    version: 1,
  });
}

function approvalSignature(payload: string): string {
  return createHmac("sha256", need("SESSION_SECRET"))
    .update(payload)
    .digest("base64url");
}

function issueApproval(
  botId: string,
  callId: string,
  connectionId: string,
  descriptorHash: string,
  name: string,
  hash: string,
  sessionId: string,
  now = Date.now()
): { token: string; expiresAt: number } {
  const expiresAt = now + APPROVAL_TTL_MS;
  const encoded = Buffer.from(
    approvalPayload(
      botId,
      callId,
      connectionId,
      descriptorHash,
      name,
      hash,
      expiresAt,
      sessionId,
      randomUUID()
    )
  ).toString("base64url");
  return {
    expiresAt,
    token: `${encoded}.${approvalSignature(encoded)}`,
  };
}

function approvalMatches(
  token: string,
  botId: string,
  callId: string,
  connectionId: string,
  descriptorHash: string,
  name: string,
  hash: string,
  sessionId: string,
  now = Date.now()
): boolean {
  const [encoded, signature] = token.split(".");
  if (
    !(encoded && signature && encoded.length < 2048 && signature.length < 256)
  ) {
    return false;
  }
  const expected = Buffer.from(approvalSignature(encoded));
  const actual = Buffer.from(signature);
  if (
    !(expected.length === actual.length && timingSafeEqual(expected, actual))
  ) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as Record<string, unknown>;
    return (
      payload.version === 1 &&
      payload.botId === botId &&
      payload.callId === callId &&
      payload.connectionId === connectionId &&
      payload.descriptorHash === descriptorHash &&
      payload.name === name &&
      payload.hash === hash &&
      payload.sessionId === sessionId &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > now
    );
  } catch {
    return false;
  }
}

function consumeApproval(
  data: Record<string, unknown>,
  token: string,
  context: McpAppCallContext,
  name: string,
  hash: string,
  descriptorHash: string
): void {
  const now = Date.now();
  const receipts = Array.isArray(data.busyMcpAppApprovals)
    ? data.busyMcpAppApprovals.filter(
        (receipt): receipt is JsonRecord =>
          isRecord(receipt) &&
          typeof receipt.consumedAt === "number" &&
          receipt.consumedAt + APPROVAL_TTL_MS > now
      )
    : [];
  const tokenHash = createHash("sha256").update(token).digest("hex");
  if (
    receipts.some(
      (receipt) =>
        receipt.tokenHash === tokenHash &&
        receipt.callId === context.callId &&
        receipt.name === name
    )
  ) {
    throw new McpAppBridgeError(
      "approval_required",
      "The MCP App approval has already been used.",
      409
    );
  }
  if (receipts.length >= MAX_ACTIVE_APPROVAL_RECEIPTS) {
    throw new McpAppBridgeError(
      "approval_required",
      "Too many pending MCP App approvals; try again shortly.",
      409
    );
  }
  data.busyMcpAppApprovals = [
    ...receipts,
    {
      argumentsHash: hash,
      botId: context.botId,
      callId: context.callId,
      connectionId: context.connectionId,
      consumedAt: now,
      descriptorHash,
      name,
      sessionId: context.sessionId,
      tokenHash,
    },
  ];
}

export function approvalDetails(error: McpAppApprovalRequiredError) {
  return {
    approval: error.approval,
    argumentsHash: error.argumentsHash,
    descriptorHash: error.descriptorHash,
    expiresAt: error.expiresAt,
    name: error.nameForApproval,
  };
}

export async function resolveMcpAppCall(
  botSlug: string,
  callId: string,
  source?: string
): Promise<McpAppCallContext> {
  const context = source
    ? await (await import("../firesides/mcp-apps")).firesideMcpAppCall(
        botSlug,
        callId,
        source
      )
    : await currentBotCall(botSlug, callId);
  if (!context) {
    throw new McpAppBridgeError("not_found", "MCP App call not found.", 404);
  }
  return context;
}

export async function readMcpAppResource(
  botSlug: string,
  callId: string,
  source?: string
): Promise<McpAppResourceResponse> {
  const context = await resolveMcpAppCall(botSlug, callId, source);
  if (!context.snapshotVerified) {
    throw new McpAppBridgeError(
      "tool_not_allowed",
      "This call did not produce a verified MCP App result.",
      409
    );
  }
  return await withAppClient(context, async ({ client, resolved }) => {
    assertAllowed(resolved.state, remoteToolName(context.toolName));
    const definitions = await listTools(client);
    const remoteName = remoteToolName(context.toolName);
    const tool = definitions.tools.find(
      (candidate) => candidate.name === remoteName
    );
    const ui = tool ? toolUiMetadata(tool._meta) : undefined;
    if (!(tool && ui?.resourceUri && isModelVisible(ui))) {
      throw new McpAppBridgeError(
        "tool_not_allowed",
        "This tool does not expose an MCP App.",
        409
      );
    }
    const resource = await readMCPAppResource({ client, uri: ui.resourceUri });
    if (Buffer.byteLength(resource.html, "utf8") > MAX_RESOURCE_BYTES) {
      throw new McpAppBridgeError(
        "resource_too_large",
        "This MCP App resource is too large to render.",
        413
      );
    }
    return {
      allowedTools: [...(resolved.state.allowedTools ?? [])],
      app: {
        connectionId: context.connectionId,
        input: context.input,
        resourceUri: ui.resourceUri,
        result: context.result,
        title: tool.title ?? resolved.entry.name,
        toolName: context.toolName,
      },
      resource,
      sandboxUrl: configuredMcpAppSandboxUrl(undefined, resource.meta?.csp),
    };
  });
}

export async function callMcpAppTool(
  botSlug: string,
  input: {
    approval?: string;
    arguments: JsonRecord;
    callId: string;
    context?: string;
    name: string;
  }
): Promise<CallToolResult> {
  const call = await resolveMcpAppCall(botSlug, input.callId, input.context);
  if (!call.snapshotVerified) {
    throw new McpAppBridgeError(
      "tool_not_allowed",
      "This call did not produce a verified MCP App result.",
      409
    );
  }
  if (Buffer.byteLength(canonicalJson(input.arguments)) > MAX_ARGUMENT_BYTES) {
    throw new McpAppBridgeError(
      "invalid_request",
      "MCP App arguments are too large.",
      400
    );
  }
  return await withAppClient(call, async ({ client, data, resolved }) => {
    assertAllowed(resolved.state, remoteToolName(call.toolName));
    const definitions = await listTools(client);
    const tool = definitions.tools
      .filter((candidate) => isAppVisible(toolUiMetadata(candidate._meta)))
      .find((candidate) => candidate.name === input.name);
    if (!(tool && isAppVisible(toolUiMetadata(tool._meta)))) {
      throw new McpAppBridgeError(
        "tool_not_allowed",
        "This tool is not available to the MCP App.",
        403
      );
    }
    assertAllowed(resolved.state, tool.name);
    const hash = argumentsHash(input.arguments);
    const descriptorHash = toolDescriptorHash(tool, resolved.state);
    const readOnly =
      tool.annotations?.readOnlyHint === true &&
      tool.annotations?.destructiveHint !== true;
    if (!(readOnly || input.approval)) {
      const issued = issueApproval(
        call.botId,
        call.callId,
        call.connectionId,
        descriptorHash,
        input.name,
        hash,
        call.sessionId
      );
      throw new McpAppApprovalRequiredError(
        issued.token,
        hash,
        descriptorHash,
        issued.expiresAt,
        input.name
      );
    }
    if (
      !(
        readOnly ||
        (input.approval &&
          approvalMatches(
            input.approval,
            call.botId,
            call.callId,
            call.connectionId,
            descriptorHash,
            input.name,
            hash,
            call.sessionId
          ))
      )
    ) {
      throw new McpAppBridgeError(
        "approval_required",
        "The MCP App approval is invalid or expired.",
        409
      );
    }
    if (!readOnly) {
      if (!input.approval) {
        throw new McpAppBridgeError(
          "approval_required",
          "The MCP App approval is invalid or expired.",
          409
        );
      }
      consumeApproval(
        data,
        input.approval,
        call,
        input.name,
        hash,
        descriptorHash
      );
    }
    return await client.callTool({
      arguments: input.arguments,
      name: input.name,
    });
  });
}

export async function requireMcpAppUser(): Promise<void> {
  if (
    process.env.NODE_ENV === "development" &&
    process.env.BUSY_DEV_NO_AUTH === "1"
  ) {
    return;
  }
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new McpAppBridgeError("unauthorized", "Unauthorized.", 401);
  }
  const [{ cookies }, { readSession, SESSION_COOKIE }] = await Promise.all([
    import("next/headers"),
    import("../auth/session"),
  ]);
  const session = await readSession(
    (await cookies()).get(SESSION_COOKIE)?.value,
    secret
  );
  if (!session) {
    throw new McpAppBridgeError("unauthorized", "Unauthorized.", 401);
  }
}

const mcpAppContext = z.string().max(73).optional();
export const mcpAppRequest = z.object({
  callId: z.string().trim().min(1).max(256),
  context: mcpAppContext,
});

export const mcpAppToolRequest = z.object({
  approval: z.string().max(4096).optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  callId: z.string().trim().min(1).max(256),
  context: mcpAppContext,
  name: z.string().trim().min(1).max(256),
});
