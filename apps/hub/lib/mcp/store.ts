import { asc, eq, sql } from "drizzle-orm";
import { db, type McpConnectionRow, mcpConnections } from "../db";
import { need } from "../env";
import {
  catalogEntry,
  catalogHash,
  catalogTools,
  MCP_CATALOG_VERSION,
  type McpCatalogEntry,
  type McpToolDescriptor,
} from "./catalog";
import { decryptOAuth, encryptOAuth } from "./crypto";
import type { OAuthData } from "./oauth";

export type McpConnectionLifecycle =
  | "active"
  | "deprecated"
  | "update"
  | "removed";

/** Review state is persisted in the encrypted OAuth envelope. */
export interface StoredMcpMetadata {
  allowedTools?: string[];
  auth?: McpCatalogEntry["auth"];
  catalogHash?: string;
  catalogVersion?: string;
  endpoint?: string;
  reviewedAt?: string;
  scopes?: string;
  tools?: McpToolDescriptor[];
}

export type McpOAuthData = OAuthData & { busyMcp?: StoredMcpMetadata };

export const publicConnection = (
  row: Pick<McpConnectionRow, "id" | "catalogId" | "status" | "error">
) => ({
  catalogId: row.catalogId,
  error: row.error,
  id: row.id,
  status: row.status,
});
export type PublicMcpConnection = ReturnType<typeof publicConnection>;

export interface PublicMcpConnectionView extends PublicMcpConnection {
  aclMode?: "enforced" | "legacy";
  allowedTools?: string[];
  catalogHash?: string;
  catalogVersion?: string;
  lifecycle?: McpConnectionLifecycle;
  reauthRequired?: boolean;
  reviewedAt?: string;
  tools?: McpToolDescriptor[];
}

/** List the app's configured MCP connections. */
export async function listConnections() {
  return await db()
    .select()
    .from(mcpConnections)
    .orderBy(asc(mcpConnections.createdAt));
}

/** Find one app-level connection by its opaque UUID. */
export async function findConnection(id: string) {
  const [row] = await db()
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, id))
    .limit(1);
  return row ?? null;
}

export async function addConnection(
  catalogId: string
): Promise<McpConnectionRow | null> {
  const entry = catalogEntry(catalogId);
  if (!entry) {
    return null;
  }
  // Repeated clicks reuse the first app connection and its authorization; an add
  // never clears credentials. Existing duplicate legacy rows remain preserved.
  // There is deliberately no UNIQUE(catalog_id): 0013_app_mcp.sql kept one
  // encrypted grant per legacy bot, so the table can hold several rows per
  // catalog id. This transaction-scoped advisory lock is what serializes new
  // adds, and no other application path creates connection rows. Do not
  // add a unique index or deduplicate rows without inventorying those grants
  // (docs/mcp-marketplace.md, "Duplicate grants").
  const result = await db().transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`busy:mcp:${catalogId}`}))`
    );
    const [existing] = await tx
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.catalogId, catalogId))
      .orderBy(asc(mcpConnections.createdAt));
    if (existing) {
      return { created: false, row: existing };
    }
    const [created] = await tx
      .insert(mcpConnections)
      .values({
        botId: null,
        catalogId,
        status: entry.auth === "none" ? "connected" : "pending",
      })
      .returning();
    return created ? { created: true, row: created } : null;
  });
  if (!result) {
    return null;
  }
  if (!result.created) {
    return result.row;
  }

  // New rows are stamped at the explicit Add action. Existing rows remain
  // legacy until an explicit discovery or review/update.
  return (
    (await withConnection<McpConnectionRow>(result.row.id, (row, data) => ({
      data: stampMetadata(data, entry),
      value: row,
    }))) ?? result.row
  );
}

export async function removeConnection(id: string) {
  await db().delete(mcpConnections).where(eq(mcpConnections.id, id));
}

/**
 * Row locking serializes rotating refresh tokens, concurrent reconnects, callbacks and deletes.
 * Return failures as values so the transaction commits state cleanup after a rejected grant.
 */
export async function withConnection<T>(
  id: string,
  run: (
    row: McpConnectionRow,
    data: OAuthData
  ) =>
    | Promise<{
        value: T;
        data: OAuthData;
        status?: McpConnectionRow["status"];
        error?: string | null;
      }>
    | {
        value: T;
        data: OAuthData;
        status?: McpConnectionRow["status"];
        error?: string | null;
      }
): Promise<T | null> {
  return await db().transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, id))
      // Serialize token writers while allowing FK checks from the separate
      // connection that saves a completed app result during this operation.
      .for("no key update");
    if (!row) {
      return null;
    }
    const secret = need("SESSION_SECRET");
    const data = row.oauthData
      ? decryptOAuth<OAuthData>(row.oauthData, row.id, secret)
      : {};
    const result = await run(row, data);
    await tx
      .update(mcpConnections)
      .set({
        oauthData: encryptOAuth(result.data, row.id, secret),
        ...(result.status === undefined ? {} : { status: result.status }),
        ...(result.error === undefined ? {} : { error: result.error }),
        updatedAt: new Date(),
      })
      .where(eq(mcpConnections.id, row.id));
    return result.value;
  });
}

function parseStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return values.length === value.length ? [...new Set(values)] : undefined;
}

function parseMetadata(value: unknown): StoredMcpMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allowedTools = parseStringList(record.allowedTools);
  const tools = Array.isArray(record.tools)
    ? (record.tools.filter((item): item is McpToolDescriptor =>
        Boolean(
          item &&
            typeof item === "object" &&
            typeof (item as { name?: unknown }).name === "string" &&
            typeof (item as { description?: unknown }).description ===
              "string" &&
            typeof (item as { readOnlyHint?: unknown }).readOnlyHint ===
              "boolean"
        )
      ) as McpToolDescriptor[])
    : undefined;
  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(record.auth === "oauth" || record.auth === "none"
      ? { auth: record.auth }
      : {}),
    ...(typeof record.catalogHash === "string"
      ? { catalogHash: record.catalogHash }
      : {}),
    ...(typeof record.catalogVersion === "string"
      ? { catalogVersion: record.catalogVersion }
      : {}),
    ...(typeof record.endpoint === "string"
      ? { endpoint: record.endpoint }
      : {}),
    ...(typeof record.reviewedAt === "string"
      ? { reviewedAt: record.reviewedAt }
      : {}),
    ...(typeof record.scopes === "string" ? { scopes: record.scopes } : {}),
    ...(tools ? { tools } : {}),
  };
}

function metadataFromRow(row: McpConnectionRow): {
  data: McpOAuthData;
  metadata?: StoredMcpMetadata;
} {
  let data: McpOAuthData = {};
  try {
    if (row.oauthData) {
      data = decryptOAuth<McpOAuthData>(
        row.oauthData,
        row.id,
        need("SESSION_SECRET")
      );
    }
  } catch {
    // A malformed/legacy secret must never make the metadata route leak or
    // invent credentials. The OAuth route will surface reconnect separately.
    return { data: {}, metadata: undefined };
  }

  const nested = parseMetadata(data.busyMcp);
  const allowedTools = nested?.allowedTools;
  const catalogVersion = nested?.catalogVersion;
  const catalogHashValue = nested?.catalogHash;
  const reviewedAt = nested?.reviewedAt;
  if (!(allowedTools || catalogVersion || catalogHashValue || reviewedAt)) {
    return { data, metadata: undefined };
  }
  return {
    data,
    metadata: {
      ...(allowedTools ? { allowedTools } : {}),
      ...(catalogVersion ? { catalogVersion } : {}),
      ...(catalogHashValue ? { catalogHash: catalogHashValue } : {}),
      ...(reviewedAt ? { reviewedAt } : {}),
      ...(nested?.auth ? { auth: nested.auth } : {}),
      ...(nested?.endpoint ? { endpoint: nested.endpoint } : {}),
      ...(nested?.scopes ? { scopes: nested.scopes } : {}),
      ...(nested?.tools ? { tools: nested.tools } : {}),
    },
  };
}

function stampMetadata(
  data: OAuthData,
  entry: McpCatalogEntry,
  discoveredTools?: readonly McpToolDescriptor[]
): McpOAuthData {
  const existing = parseMetadata((data as McpOAuthData).busyMcp);
  const next: StoredMcpMetadata = {
    ...existing,
    allowedTools: existing?.allowedTools ?? [],
    auth: entry.auth,
    catalogHash: catalogHash(entry),
    catalogVersion: MCP_CATALOG_VERSION,
    endpoint: entry.url,
    reviewedAt: existing?.reviewedAt ?? new Date().toISOString(),
    scopes: entry.oauthScopes,
    tools: [...(discoveredTools ?? existing?.tools ?? catalogTools())],
  };
  return { ...data, busyMcp: next };
}

function lifecycleFor(
  entry: McpCatalogEntry | undefined,
  metadata: StoredMcpMetadata | undefined
): { lifecycle: McpConnectionLifecycle; reauthRequired: boolean } {
  if (!entry) {
    return { lifecycle: "removed", reauthRequired: true };
  }
  if (metadata?.catalogHash && metadata.catalogHash !== catalogHash(entry)) {
    return {
      lifecycle: "update",
      reauthRequired:
        (metadata.endpoint !== undefined && metadata.endpoint !== entry.url) ||
        (metadata.scopes !== undefined &&
          metadata.scopes !== (entry.oauthScopes ?? "")) ||
        (metadata.auth !== undefined && metadata.auth !== entry.auth),
    };
  }
  return {
    lifecycle: entry.lifecycle ?? "active",
    reauthRequired: false,
  };
}

/** Add catalog state without ever including the encrypted OAuth envelope. */
export function publicConnectionView(
  row: McpConnectionRow
): PublicMcpConnectionView {
  const base = publicConnection(row);
  const entry = catalogEntry(row.catalogId);
  const { metadata } = metadataFromRow(row);
  if (!metadata) {
    return { ...base, aclMode: "legacy" };
  }
  const lifecycle = lifecycleFor(entry, metadata);
  return {
    ...base,
    aclMode: "enforced",
    allowedTools: metadata.allowedTools ?? [],
    catalogHash: metadata.catalogHash,
    catalogVersion: metadata.catalogVersion,
    lifecycle: lifecycle.lifecycle,
    reauthRequired: lifecycle.reauthRequired,
    reviewedAt: metadata.reviewedAt,
    tools: metadata.tools ?? [...catalogTools()],
  };
}

/** A connection's current ACL and catalog state for the bot runtime. */
export async function connectionRuntimeState(row: McpConnectionRow) {
  const view = await publicConnectionView(row);
  if (view.aclMode === "legacy") {
    // Legacy rows keep the existing approval policy until an explicit server
    // discovery/review. Do not turn them into an empty enforced allowlist.
    return view;
  }
  const entry = catalogEntry(row.catalogId);
  return {
    ...view,
    aclMode: "enforced" as const,
    allowedTools: view.allowedTools ?? [],
    lifecycle:
      view.lifecycle ?? (entry ? (entry.lifecycle ?? "active") : "removed"),
    tools: view.tools ?? [...catalogTools()],
  };
}

export async function updateAllowedTools(id: string, allowedTools: string[]) {
  const row = await findConnection(id);
  if (!row) {
    return null;
  }
  const entry = catalogEntry(row.catalogId);
  if (!entry) {
    throw Object.assign(new Error("This catalog entry was removed."), {
      status: 409,
    });
  }
  const { metadata } = metadataFromRow(row);
  const current = publicConnectionView(row);
  if (current.lifecycle === "update" || current.reauthRequired) {
    throw Object.assign(
      new Error("Review this MCP update before changing its tools."),
      { status: 409 }
    );
  }
  const known = new Set(
    (metadata?.tools ?? catalogTools()).map((tool) => tool.name)
  );
  const next = [...new Set(allowedTools)];
  if (next.some((name) => !known.has(name))) {
    throw Object.assign(new Error("Choose tools from the reviewed catalog."), {
      status: 400,
    });
  }
  const saved = await withConnection<PublicMcpConnectionView>(
    id,
    (selected, data) => {
      const stamped = stampMetadata(data, entry);
      const stampedMetadata = parseMetadata(stamped.busyMcp) ?? {};
      const nextData: McpOAuthData = {
        ...stamped,
        busyMcp: { ...stampedMetadata, allowedTools: next },
      };
      return {
        data: nextData,
        value: { ...publicConnection(selected), allowedTools: next },
      };
    }
  );
  return saved;
}

/** Persist an authenticated server's reviewed tools without exposing its token. */
export async function saveDiscoveredTools(
  id: string,
  tools: readonly McpToolDescriptor[]
) {
  const row = await listConnections().then((rows) =>
    rows.find((candidate) => candidate.id === id)
  );
  if (!row) {
    return null;
  }
  const entry = catalogEntry(row.catalogId);
  if (!entry) {
    throw Object.assign(new Error("This catalog entry was removed."), {
      status: 409,
    });
  }
  const known = new Set(tools.map((tool) => tool.name));
  return await withConnection<PublicMcpConnectionView>(id, (selected, data) => {
    const stamped = stampMetadata(data, entry, tools);
    const metadata = parseMetadata(stamped.busyMcp) ?? {};
    const allowedTools = (
      metadata.allowedTools ??
      tools
        .filter((tool) => tool.readOnlyHint && !tool.destructiveHint)
        .map((tool) => tool.name)
    ).filter((name) => known.has(name));
    return {
      data: {
        ...stamped,
        busyMcp: { ...metadata, allowedTools, tools: [...tools] },
      },
      error: null,
      value: {
        ...publicConnection(selected),
        allowedTools,
        catalogHash: catalogHash(entry),
        catalogVersion: MCP_CATALOG_VERSION,
        lifecycle: entry.lifecycle ?? "active",
        reviewedAt: new Date().toISOString(),
        tools: [...tools],
      },
    };
  });
}

/** Explicitly accept the reviewed descriptor currently shipped in the catalog. */
export async function reviewCatalogUpdate(id: string) {
  const row = await listConnections().then((rows) =>
    rows.find((candidate) => candidate.id === id)
  );
  if (!row) {
    return null;
  }
  const entry = catalogEntry(row.catalogId);
  if (!entry) {
    throw Object.assign(new Error("This catalog entry was removed."), {
      status: 409,
    });
  }
  return await withConnection<PublicMcpConnectionView>(id, (selected, data) => {
    const previous = parseMetadata((data as McpOAuthData).busyMcp);
    const reauthRequired =
      entry.auth === "oauth" &&
      (!previous ||
        (previous.endpoint !== undefined && previous.endpoint !== entry.url) ||
        (previous.scopes ?? "") !== (entry.oauthScopes ?? "") ||
        (previous.auth !== undefined && previous.auth !== entry.auth));
    const stamped = stampMetadata(data, entry);
    const metadata = parseMetadata(stamped.busyMcp) ?? {};
    const reviewedTools = metadata.tools ?? catalogTools();
    const safeAllowed = (metadata.allowedTools ?? []).filter((name) =>
      reviewedTools.some((tool) => tool.name === name)
    );
    const nextData: McpOAuthData = {
      ...stamped,
      busyMcp: { ...metadata, allowedTools: safeAllowed },
    };
    if (reauthRequired) {
      nextData.tokens = undefined;
      nextData.tokensIssuedAt = undefined;
    }
    let nextStatus = selected.status;
    if (reauthRequired) {
      nextStatus = "pending";
    } else if (entry.auth === "none") {
      nextStatus = "connected";
    }
    return {
      data: nextData,
      error: reauthRequired ? "Reconnect this MCP in the marketplace." : null,
      status: nextStatus,
      value: {
        ...publicConnection(selected),
        allowedTools: safeAllowed,
        catalogHash: catalogHash(entry),
        catalogVersion: MCP_CATALOG_VERSION,
        lifecycle: entry.lifecycle ?? "active",
        reauthRequired,
        reviewedAt: new Date().toISOString(),
        tools: [...catalogTools()],
      },
    };
  });
}
