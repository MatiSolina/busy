import { randomUUID, timingSafeEqual } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db, mcpConnections, mcpProviderClients } from "@/lib/db";
import { need } from "@/lib/env";
import { MCP_CATALOG } from "./catalog";
import { decryptOAuth, encryptOAuth } from "./crypto";
import { registeredHubOrigin } from "./provider-origin";

/** Providers whose OAuth client must be created once by the Busy operator. */
export const REGISTERED_PROVIDERS = ["github", "google"] as const;
export type RegisteredProvider = (typeof REGISTERED_PROVIDERS)[number];

interface ProviderInfo {
  docsUrl: string;
  setupUrl: string;
}

const PROVIDER_INFO: Record<RegisteredProvider, ProviderInfo> = {
  github: {
    docsUrl:
      "https://github.com/github/github-mcp-server/blob/main/docs/host-integration.md",
    setupUrl: "https://github.com/settings/developers",
  },
  google: {
    docsUrl:
      "https://developers.google.com/workspace/guides/configure-mcp-servers",
    setupUrl:
      "https://console.cloud.google.com/apis/credentials?project=lft-orca-dev",
  },
};

const providerClientSchema = z.object({
  clientId: z.string().trim().min(1).max(512),
  // An empty/omitted secret means “keep the existing secret” on an edit. The
  // save path rejects that form for first-time setup or a changed client ID.
  // Secrets are not trimmed: an OAuth provider may technically issue one with surrounding whitespace.
  clientSecret: z
    .string()
    .max(4096)
    .optional()
    .transform((value) => value || undefined),
});

export interface ProviderClientInput {
  clientId: string;
  clientSecret?: string;
}
interface StoredProviderClient {
  clientId: string;
  clientSecret: string;
}
export type ProviderClient = StoredProviderClient & { version: string };
export class InvalidProviderClientInputError extends Error {
  constructor() {
    super("Invalid provider credentials");
    this.name = "InvalidProviderClientInputError";
  }
}

export interface ProviderSetup {
  clientId: string | null;
  configured: boolean;
  docsUrl: string;
  provider: RegisteredProvider;
  redirectUri: string;
  setupUrl: string;
  version: string | null;
}

export function isRegisteredProvider(
  value: string
): value is RegisteredProvider {
  return (REGISTERED_PROVIDERS as readonly string[]).includes(value);
}

export function parseProviderClientInput(
  value: unknown
): ProviderClientInput | null {
  const parsed = providerClientSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.clientSecret === undefined
    ? { clientId: parsed.data.clientId }
    : {
        clientId: parsed.data.clientId,
        clientSecret: parsed.data.clientSecret,
      };
}

function providerAad(provider: RegisteredProvider): string {
  return `provider:${provider}`;
}

function redirectUri(provider: RegisteredProvider): string {
  const base = registeredHubOrigin();
  return `${base}/api/mcp/oauth/${provider}/callback`;
}

export function providerSetup(
  provider: RegisteredProvider,
  version: string | null,
  clientId: string | null
): ProviderSetup {
  return {
    clientId,
    configured: Boolean(version),
    provider,
    redirectUri: redirectUri(provider),
    version,
    ...PROVIDER_INFO[provider],
  };
}

/** Read-only UI projection. It never decrypts or returns the client secret. */
export async function getProviderSetup(
  provider: RegisteredProvider
): Promise<ProviderSetup> {
  const [row] = await db()
    .select({
      sealedClient: mcpProviderClients.sealedClient,
      version: mcpProviderClients.version,
    })
    .from(mcpProviderClients)
    .where(eq(mcpProviderClients.provider, provider));
  if (!row) {
    return providerSetup(provider, null, null);
  }

  // The client ID is safe to show, but only after authenticated decryption. A
  // stale SESSION_SECRET therefore fails closed instead of reporting a usable
  // configuration that all future OAuth calls would reject.
  const client = decryptProviderClient(row.sealedClient, provider);
  return providerSetup(provider, row.version, client.clientId);
}

export async function getProviderClient(
  provider: RegisteredProvider
): Promise<ProviderClient | null> {
  const [row] = await db()
    .select({
      sealedClient: mcpProviderClients.sealedClient,
      version: mcpProviderClients.version,
    })
    .from(mcpProviderClients)
    .where(eq(mcpProviderClients.provider, provider));
  if (!row) {
    return null;
  }
  return {
    ...decryptProviderClient(row.sealedClient, provider),
    version: row.version,
  };
}

function decryptProviderClient(
  sealedClient: string,
  provider: RegisteredProvider
): StoredProviderClient {
  try {
    const value = decryptOAuth<unknown>(
      sealedClient,
      providerAad(provider),
      need("SESSION_SECRET")
    );
    const parsed = providerClientSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error("invalid provider client payload");
    }
    if (!parsed.data.clientSecret) {
      throw new Error("missing provider client secret");
    }
    return {
      clientId: parsed.data.clientId,
      clientSecret: parsed.data.clientSecret,
    };
  } catch {
    // biome-ignore lint/style/useErrorCause: Stored credential parse failures must not expose encrypted values.
    throw new Error("Stored provider credentials are invalid");
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function sameClient(
  left: StoredProviderClient,
  right: ProviderClientInput
): boolean {
  const secret = right.clientSecret;
  return (
    Boolean(secret) &&
    left.clientId === right.clientId &&
    sameSecret(left.clientSecret, secret ?? "")
  );
}

/**
 * Stores one encrypted client per registered provider. Changing it invalidates
 * only catalog entries explicitly owned by that provider; DCR-based entries
 * keep their existing grants.
 */
export async function saveProviderClient(
  provider: RegisteredProvider,
  input: ProviderClientInput
): Promise<{ version: string; changed: boolean }> {
  const parsed = parseProviderClientInput(input);
  if (!parsed) {
    throw new InvalidProviderClientInputError();
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Credential rotation must validate, lock, compare, and invalidate grants atomically.
  return await db().transaction(async (tx) => {
    // The first-save path has no row to lock. A transaction advisory lock keeps
    // two simultaneous setup requests for one provider from racing to rotate
    // different versions and invalidate grants twice.
    if (typeof tx.execute === "function") {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`busy:mcp-provider:${provider}`}))`
      );
    }
    const [current] = await tx
      .select({
        sealedClient: mcpProviderClients.sealedClient,
        version: mcpProviderClients.version,
      })
      .from(mcpProviderClients)
      .where(eq(mcpProviderClients.provider, provider))
      .for("update");

    let currentClient: StoredProviderClient | null = null;
    if (current) {
      try {
        currentClient = decryptProviderClient(current.sealedClient, provider);
        if (
          currentClient.clientId === parsed.clientId &&
          (!parsed.clientSecret || sameClient(currentClient, parsed))
        ) {
          return { changed: false, version: current.version };
        }
      } catch {
        // A corrupted/old ciphertext must be replaced by the new configured client.
      }
    }

    if (
      !parsed.clientSecret &&
      (!currentClient || currentClient.clientId !== parsed.clientId)
    ) {
      throw new InvalidProviderClientInputError();
    }
    const clientSecret = parsed.clientSecret ?? currentClient?.clientSecret;
    if (!clientSecret) {
      throw new InvalidProviderClientInputError();
    }
    const nextClient = {
      clientId: parsed.clientId,
      clientSecret,
    };

    const version = randomUUID();
    const sealedClient = encryptOAuth(
      nextClient,
      providerAad(provider),
      need("SESSION_SECRET")
    );
    await tx
      .insert(mcpProviderClients)
      .values({ provider, sealedClient, updatedAt: new Date(), version })
      .onConflictDoUpdate({
        set: { sealedClient, updatedAt: new Date(), version },
        target: mcpProviderClients.provider,
      });

    const catalogIds = MCP_CATALOG.filter(
      (entry) =>
        (entry as typeof entry & { oauthProvider?: string }).oauthProvider ===
        provider
    ).map((entry) => entry.id);
    if (catalogIds.length) {
      await tx
        .update(mcpConnections)
        .set({
          error: "Provider credentials changed. Reconnect this MCP.",
          oauthData: null,
          status: "error",
          updatedAt: new Date(),
        })
        .where(inArray(mcpConnections.catalogId, catalogIds));
    }

    return { changed: true, version };
  });
}

export const providerInfo = (provider: RegisteredProvider): ProviderInfo =>
  PROVIDER_INFO[provider];
