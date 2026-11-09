import { z } from "zod";
import {
  catalogEntry,
  catalogHash,
  catalogTools,
  MCP_CATALOG,
  MCP_CATALOG_VERSION,
} from "./catalog";
import { connectionId as connectionIdSchema } from "./http";
import { createConnectIntent } from "./intent";
import { getProviderClient } from "./provider-clients";
import {
  addConnection,
  findConnection,
  listConnections,
  type PublicMcpConnection,
  publicConnection,
  publicConnectionView,
  reviewCatalogUpdate,
  withConnection,
} from "./store";

export async function marketplaceSnapshot() {
  const [github, google, connections] = await Promise.all([
    getProviderClient("github"),
    getProviderClient("google"),
    listConnections(),
  ]);
  const configured = { github: Boolean(github), google: Boolean(google) };
  const catalog = MCP_CATALOG.map((entry) => ({
    ...entry,
    catalogHash: catalogHash(entry),
    catalogVersion: MCP_CATALOG_VERSION,
    lifecycle: entry.lifecycle ?? "active",
    tools: [...catalogTools()],
    ...(typeof entry === "object" &&
    "oauthProvider" in entry &&
    entry.oauthProvider
      ? { configured: configured[entry.oauthProvider] }
      : {}),
  }));
  return {
    catalog,
    connections: await Promise.all(
      connections.map((row) => publicConnectionView(row))
    ),
  };
}

export async function addMarketplaceConnection(req: Request) {
  const input = z
    .object({
      catalogId: z.string(),
      connectionId: connectionIdSchema.optional(),
    })
    .safeParse(await req.json().catch(() => null));
  if (!(input.success && catalogEntry(input.data.catalogId))) {
    return {
      error: "Choose a service from the marketplace.",
      status: 400 as const,
    };
  }

  const selectedEntry = catalogEntry(input.data.catalogId);
  if (!selectedEntry) {
    return {
      error: "Choose a service from the marketplace.",
      status: 400 as const,
    };
  }
  if (selectedEntry.lifecycle === "deprecated") {
    return {
      error: "This catalog entry is deprecated and cannot be newly connected.",
      status: 409 as const,
    };
  }
  if (
    "oauthProvider" in selectedEntry &&
    selectedEntry.oauthProvider &&
    !(await getProviderClient(selectedEntry.oauthProvider))
  ) {
    return {
      error: `Set up ${selectedEntry.oauthProvider === "github" ? "GitHub" : "Google"} before connecting this app.`,
      status: 409 as const,
    };
  }

  const row = input.data.connectionId
    ? await findConnection(input.data.connectionId).then((candidate) =>
        candidate?.catalogId === input.data.catalogId ? candidate : null
      )
    : await addConnection(input.data.catalogId);
  if (!row) {
    return {
      error: input.data.connectionId
        ? "Connection not found."
        : "Couldn't add this connection.",
      status: input.data.connectionId ? (404 as const) : (409 as const),
    };
  }
  let ticket: string | null = null;
  let connection = await publicConnectionView(row);
  if (selectedEntry.auth === "oauth" && row.status !== "connected") {
    const intent = createConnectIntent();
    const saved = await withConnection<{
      connection: PublicMcpConnection;
      ticket: string | null;
    }>(row.id, (selected, data) => {
      if (selected.status === "connected") {
        return {
          data,
          value: { connection: publicConnection(selected), ticket: null },
        };
      }
      const next = {
        ...data,
        codeVerifier: undefined,
        connectIntent: intent,
        flowStartedAt: undefined,
        state: undefined,
      };
      return {
        data: next,
        error: null,
        status: "pending",
        value: {
          connection: {
            ...publicConnection(selected),
            error: null,
            status: "pending",
          },
          ticket: intent.token,
        },
      };
    });
    if (!saved) {
      return { error: "Couldn't prepare sign-in.", status: 409 as const };
    }
    ({ ticket, connection } = saved);
  }

  return {
    connection,
    connectUrl: ticket
      ? `/api/mcp/${row.id}/connect?ticket=${encodeURIComponent(ticket)}`
      : null,
    status: 200 as const,
  };
}

export async function updateMarketplaceConnection(id: string) {
  try {
    const connection = await reviewCatalogUpdate(id);
    return connection
      ? { connection, status: 200 as const }
      : { error: "Connection not found.", status: 404 as const };
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 409;
    return {
      error:
        error instanceof Error
          ? error.message
          : "Couldn't update this connection.",
      status: status === 400 ? (400 as const) : (409 as const),
    };
  }
}
