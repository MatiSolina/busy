import type { CallToolResult, ListToolsResult } from "@ai-sdk/mcp";
import { z } from "zod";
import { findMcpAppResult, saveMcpAppResult } from "./app-results";
import { type McpOpenClient, withMcpConnectionClient } from "./apps-client";
import { isModelVisible, MCP_APP_RESULT_KEY, toolUiMetadata } from "./tool-ui";

const BUSY_ARGUMENT = "__busy";
const JSON_RPC_VERSION = "2.0";
const MAX_TOOL_LIST_PAGES = 100;
const REQUEST_ID = z.union([z.string(), z.number().int()]);
const requestSchema = z.object({
  id: REQUEST_ID.optional(),
  jsonrpc: z.literal(JSON_RPC_VERSION),
  method: z.string().min(1).max(128),
  params: z.record(z.string(), z.unknown()).optional(),
});

type JsonRecord = Record<string, unknown>;

export interface McpModelProxyContext {
  botId: string;
  botSessionId: string | null;
  connectionId: string;
}

interface BusyCallContext {
  callId: string;
  connectionId: string;
  resourceUri?: string;
  sessionId: string;
  toolName: string;
}

class ProxyError extends Error {
  readonly code: number;

  constructor(message: string, code = -32_000) {
    super(message);
    this.code = code;
    this.name = "McpModelProxyError";
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function response(id: string | number | undefined, result: unknown): Response {
  const payload = isRecord(result)
    ? { ...result, resultType: result.resultType ?? "final" }
    : { result, resultType: "final" };
  return Response.json(
    { id, jsonrpc: JSON_RPC_VERSION, result: payload },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function errorResponse(
  id: string | number | undefined,
  error: unknown
): Response {
  const message =
    error instanceof ProxyError
      ? error.message
      : "MCP connection could not complete this request.";
  const code = error instanceof ProxyError ? error.code : -32_000;
  return Response.json(
    {
      error: { code, message },
      id: id ?? null,
      jsonrpc: JSON_RPC_VERSION,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

function busyContext(value: unknown): BusyCallContext {
  if (!isRecord(value)) {
    throw new ProxyError("MCP App call context is missing.", -32_602);
  }
  const callId = stringValue(value.callId);
  const connectionId = stringValue(value.connectionId);
  const sessionId = stringValue(value.sessionId);
  const toolName = stringValue(value.toolName);
  const resourceUri = stringValue(value.resourceUri);
  if (!(callId && connectionId && sessionId && toolName)) {
    throw new ProxyError("MCP App call context is invalid.", -32_602);
  }
  return { callId, connectionId, resourceUri, sessionId, toolName };
}

function paramsRecord(params: unknown): JsonRecord {
  if (!isRecord(params)) {
    throw new ProxyError("MCP request parameters are invalid.", -32_602);
  }
  return params;
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .filter(
      (part): part is { text: string; type: "text" } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string"
    )
    .map((part) => part.text)
    .join("\n");
}

function safeStructuredContent(
  value: unknown,
  fallback: string,
  snapshotId: string
): unknown {
  if (isRecord(value)) {
    return {
      ...value,
      [MCP_APP_RESULT_KEY]: { snapshotId },
    };
  }
  return {
    result: value ?? (fallback || null),
    [MCP_APP_RESULT_KEY]: { snapshotId },
  };
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

function withoutRemoteMetadata(result: CallToolResult): JsonRecord {
  if (!isRecord(result)) {
    return { structuredContent: result };
  }
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "_meta")
  );
}

async function listTools(
  client: McpOpenClient["client"],
  params: JsonRecord | undefined,
  allowedTools: readonly string[]
): Promise<ListToolsResult> {
  const cursor = stringValue(params?.cursor);
  const page = await client.listTools(
    cursor ? { params: { cursor } } : undefined
  );
  const allowed = new Set(allowedTools);
  return {
    ...page,
    tools: page.tools.filter(
      (tool) =>
        allowed.has(tool.name) && isModelVisible(toolUiMetadata(tool._meta))
    ),
  };
}

/** Read every bounded page when validating a live tools/call descriptor. */
async function listAllTools(
  client: McpOpenClient["client"],
  allowedTools: readonly string[]
): Promise<ListToolsResult["tools"]> {
  const tools: ListToolsResult["tools"] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_TOOL_LIST_PAGES; pageNumber += 1) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new ProxyError(
          "MCP tool metadata pagination repeated a cursor.",
          -32_409
        );
      }
      seenCursors.add(cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: MCP pagination is cursor-ordered.
    const page = await listTools(
      client,
      cursor === undefined ? undefined : { cursor },
      allowedTools
    );
    tools.push(...page.tools);
    const nextCursor = stringValue(page.nextCursor);
    if (nextCursor === undefined) {
      return tools;
    }
    cursor = nextCursor;
  }

  throw new ProxyError(
    "MCP tool metadata pagination exceeded the safety limit.",
    -32_409
  );
}

async function toolsCall(
  client: McpOpenClient["client"],
  params: JsonRecord,
  context: McpModelProxyContext,
  allowedTools: readonly string[]
): Promise<JsonRecord> {
  const name = stringValue(params.name);
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (!name) {
    throw new ProxyError("MCP tool name is required.", -32_602);
  }
  if (!allowedTools.includes(name)) {
    throw new ProxyError(
      "This MCP tool is not enabled for the current connection.",
      -32_003
    );
  }
  const busy = busyContext(args[BUSY_ARGUMENT]);
  if (
    busy.connectionId !== context.connectionId ||
    busy.sessionId !== context.botSessionId ||
    busy.toolName !== name
  ) {
    throw new ProxyError(
      "MCP App call context does not match this session.",
      -32_602
    );
  }
  const cleanArguments = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== BUSY_ARGUMENT)
  );
  const liveTools = await listAllTools(client, allowedTools);
  const liveTool = liveTools.find((tool) => tool.name === name);
  const liveUi = liveTool ? toolUiMetadata(liveTool._meta) : undefined;
  if (!liveTool || liveUi?.resourceUri !== busy.resourceUri) {
    throw new ProxyError(
      "This MCP tool metadata changed; request it again.",
      -32_409
    );
  }
  const replay = await replaySnapshot(context, busy, cleanArguments);
  if (replay !== undefined) {
    return replay;
  }
  const result = await client.callTool({
    arguments: cleanArguments,
    name,
  });
  if (result.isError === true) {
    return withoutRemoteMetadata(result);
  }
  if (!busy.resourceUri) {
    return withoutRemoteMetadata(result);
  }
  const snapshotId = await saveMcpAppResult({
    botId: context.botId,
    callId: busy.callId,
    connectionId: context.connectionId,
    input: cleanArguments,
    result,
    sessionId: busy.sessionId,
    toolName: name,
  }).catch(() => undefined);
  return snapshotId === undefined
    ? withoutRemoteMetadata(result)
    : appResultOutput(result, snapshotId);
}

async function replaySnapshot(
  context: McpModelProxyContext,
  busy: BusyCallContext,
  input: JsonRecord
): Promise<JsonRecord | undefined> {
  if (!busy.resourceUri) {
    return undefined;
  }
  const existing = await findMcpAppResult({
    botId: context.botId,
    callId: busy.callId,
    connectionId: context.connectionId,
    sessionId: busy.sessionId,
  });
  if (!existing) {
    return undefined;
  }
  if (canonicalJson(existing.snapshot.input) !== canonicalJson(input)) {
    throw new ProxyError(
      "MCP App replay arguments do not match the original call.",
      -32_602
    );
  }
  return appResultOutput(
    existing.snapshot.result as CallToolResult,
    existing.id
  );
}

function appResultOutput(
  result: CallToolResult,
  snapshotId: string
): JsonRecord {
  const safe = withoutRemoteMetadata(result);
  const content = Array.isArray(safe.content)
    ? [
        ...safe.content,
        {
          text: JSON.stringify({
            [MCP_APP_RESULT_KEY]: { snapshotId },
          }),
          type: "text",
        },
      ]
    : safe.content;
  return {
    ...safe,
    ...(Array.isArray(content) ? { content } : {}),
    structuredContent: safeStructuredContent(
      result.structuredContent,
      textContent(content),
      snapshotId
    ),
  };
}

function discoveryResult(client: {
  initializeResult: {
    capabilities: unknown;
    instructions?: string;
    protocolVersion: string;
    serverInfo: unknown;
  };
}) {
  const initialize = client.initializeResult;
  return {
    capabilities: initialize.capabilities,
    instructions: initialize.instructions,
    resultType: "final",
    serverInfo: initialize.serverInfo,
    supportedVersions: [initialize.protocolVersion],
  };
}

function initializeResult(client: McpOpenClient["client"]) {
  return { ...client.initializeResult, resultType: "final" };
}

export async function proxyMcpRequest(
  body: unknown,
  context: McpModelProxyContext
): Promise<Response> {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      undefined,
      new ProxyError("MCP request is invalid.", -32_600)
    );
  }
  const { id, method, params } = parsed.data;
  if (
    method === "notifications/initialized" ||
    method === "notifications/cancelled"
  ) {
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 202,
    });
  }
  try {
    return await withMcpConnectionClient(
      context.connectionId,
      async ({ client, resolved }) => {
        if (method === "ping") {
          return response(id, {});
        }
        if (method === "server/discover") {
          return response(id, discoveryResult(client));
        }
        if (method === "initialize") {
          return response(id, initializeResult(client));
        }
        if (method === "tools/list") {
          return response(
            id,
            await listTools(client, params, resolved.state.allowedTools ?? [])
          );
        }
        if (method === "tools/call") {
          return response(
            id,
            await toolsCall(
              client,
              paramsRecord(params),
              context,
              resolved.state.allowedTools ?? []
            )
          );
        }
        throw new ProxyError(`MCP method is not supported: ${method}`, -32_601);
      }
    );
  } catch (error) {
    return errorResponse(id, error);
  }
}
