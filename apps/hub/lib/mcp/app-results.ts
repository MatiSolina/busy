import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, mcpAppResults } from "../db";
import { need } from "../env";
import { decryptOAuth, encryptOAuth } from "./crypto";

interface McpAppResultScope {
  botId: string;
  callId: string;
  connectionId: string;
  sessionId: string;
}

export interface McpAppResultSnapshot extends McpAppResultScope {
  input: Record<string, unknown>;
  result: unknown;
  toolName: string;
}

function resultKey(
  id: string,
  snapshot: McpAppResultScope & { toolName: string }
): string {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.botId,
        snapshot.callId,
        snapshot.connectionId,
        snapshot.sessionId,
        snapshot.toolName,
      ])
    )
    .digest("hex");
  return `app-result:${id}:${scope}`;
}

/** The sealed payload is domain-bound to this snapshot, not an OAuth row. */
export async function saveMcpAppResult(
  snapshot: McpAppResultSnapshot
): Promise<string> {
  const id = randomUUID();
  const sealedResult = encryptOAuth(
    { input: snapshot.input, result: snapshot.result },
    resultKey(id, snapshot),
    need("SESSION_SECRET")
  );
  await db().insert(mcpAppResults).values({
    botId: snapshot.botId,
    callId: snapshot.callId,
    connectionId: snapshot.connectionId,
    id,
    sealedResult,
    sessionId: snapshot.sessionId,
    toolName: snapshot.toolName,
  });
  return id;
}

export async function getMcpAppResult(
  id: string,
  scope: McpAppResultScope
): Promise<McpAppResultSnapshot | null> {
  const snapshot = await getMcpAppResultForCall(id, scope);
  return snapshot?.connectionId === scope.connectionId ? snapshot : null;
}

/** The opaque result id plus the actual Eve call determines its connection. */
export async function getMcpAppResultForCall(
  id: string,
  scope: Omit<McpAppResultScope, "connectionId">
): Promise<McpAppResultSnapshot | null> {
  const [row] = await db()
    .select()
    .from(mcpAppResults)
    .where(
      and(
        eq(mcpAppResults.id, id),
        eq(mcpAppResults.botId, scope.botId),
        eq(mcpAppResults.callId, scope.callId),
        eq(mcpAppResults.sessionId, scope.sessionId)
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const payload = decryptOAuth<{
    input: Record<string, unknown>;
    result: unknown;
  }>(row.sealedResult, resultKey(row.id, row), need("SESSION_SECRET"));
  return {
    ...scope,
    ...payload,
    connectionId: row.connectionId,
    toolName: row.toolName,
  };
}

/** Called under the connection lock before an upstream execution is retried. */
export async function findMcpAppResult(
  scope: McpAppResultScope
): Promise<{ id: string; snapshot: McpAppResultSnapshot } | null> {
  const [row] = await db()
    .select({ id: mcpAppResults.id })
    .from(mcpAppResults)
    .where(
      and(
        eq(mcpAppResults.botId, scope.botId),
        eq(mcpAppResults.callId, scope.callId),
        eq(mcpAppResults.connectionId, scope.connectionId),
        eq(mcpAppResults.sessionId, scope.sessionId)
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const snapshot = await getMcpAppResult(row.id, scope);
  return snapshot ? { id: row.id, snapshot } : null;
}
