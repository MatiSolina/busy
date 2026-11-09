import assert from "node:assert/strict";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, PUT } from "./app/api/mcp/providers/[provider]/route";
import { decryptOAuth } from "./lib/mcp/crypto";
import {
  getProviderClient,
  getProviderSetup,
  parseProviderClientInput,
  saveProviderClient,
} from "./lib/mcp/provider-clients";

interface ProviderRow {
  provider: string;
  sealedClient: string;
  updatedAt: Date;
  version: string;
}
interface ConnectionRow {
  catalogId: string;
  error: string | null;
  oauthData: string | null;
  status: "pending" | "connected" | "error";
}

const harness = vi.hoisted(() => {
  const providerRows = new Map<string, ProviderRow>();
  const connectionRows: ConnectionRow[] = [
    {
      catalogId: "github",
      error: null,
      oauthData: "sealed-github",
      status: "connected",
    },
    {
      catalogId: "google",
      error: null,
      oauthData: "sealed-google",
      status: "connected",
    },
    {
      catalogId: "linear",
      error: null,
      oauthData: "sealed-linear",
      status: "connected",
    },
  ];
  const providerTable = {
    provider: "provider",
    sealedClient: "sealedClient",
    updatedAt: "updatedAt",
    version: "version",
  };
  const connectionTable = {
    catalogId: "catalogId",
    error: "error",
    oauthData: "oauthData",
    status: "status",
    updatedAt: "updatedAt",
  };
  const rowsFor = (table: unknown) =>
    table === providerTable ? [...providerRows.values()] : connectionRows;
  const query = (table: unknown) => {
    const p = Promise.resolve(rowsFor(table));
    return Object.assign(p, { for: async () => rowsFor(table) });
  };
  const select = vi.fn(() => ({
    from: (table: unknown) => ({ where: () => query(table) }),
  }));
  const insert = vi.fn(() => ({
    values: (value: ProviderRow) => ({
      onConflictDoUpdate: ({ set }: { set: Partial<ProviderRow> }) => {
        providerRows.set(value.provider, { ...value, ...set });
      },
    }),
  }));
  const update = vi.fn(() => ({
    set: (patch: Partial<ConnectionRow>) => ({
      where: (condition: { values?: string[] }) => {
        const targets =
          condition.values ?? connectionRows.map((row) => row.catalogId);
        for (const row of connectionRows) {
          if (targets.includes(row.catalogId)) {
            Object.assign(row, patch);
          }
        }
      },
    }),
  }));
  const tx = { insert, select, update };
  const db = vi.fn(() => ({
    select,
    transaction: async <T>(run: (value: typeof tx) => Promise<T>) => run(tx),
  }));
  const need = vi.fn((key: string) =>
    key === "HUB_URL"
      ? "https://busy.example.com"
      : "provider-client-test-secret-long-enough"
  );
  return {
    connectionRows,
    connectionTable,
    db,
    insert,
    need,
    providerRows,
    providerTable,
    select,
    update,
  };
});

vi.mock("@/lib/db", () => ({
  db: harness.db,
  mcpConnections: harness.connectionTable,
  mcpProviderClients: harness.providerTable,
}));
vi.mock("@/lib/env", () => ({ need: harness.need }));
vi.mock("@/lib/mcp/catalog", () => ({
  MCP_CATALOG: [
    { id: "github", oauthProvider: "github" },
    { id: "google", oauthProvider: "google" },
    { id: "linear" },
  ],
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: string, value: string) => ({ column, value }),
  inArray: (_column: string, values: string[]) => ({ values }),
}));

const secret = "provider-client-test-secret-long-enough";
const params = (provider: string) => ({
  params: Promise.resolve({ provider }),
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.providerRows.clear();
  harness.connectionRows.splice(
    0,
    harness.connectionRows.length,
    {
      catalogId: "github",
      error: null,
      oauthData: "sealed-github",
      status: "connected",
    },
    {
      catalogId: "google",
      error: null,
      oauthData: "sealed-google",
      status: "connected",
    },
    {
      catalogId: "linear",
      error: null,
      oauthData: "sealed-linear",
      status: "connected",
    }
  );
});

describe("registered OAuth provider client storage", () => {
  it("encrypts the client secret and never includes it in the setup projection", async () => {
    const saved = await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    const row = harness.providerRows.get("github");
    assert(row);
    expect(saved.changed).toBe(true);
    expect(row.sealedClient).not.toContain("github-secret");
    expect(decryptOAuth(row.sealedClient, "provider:github", secret)).toEqual({
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    await expect(getProviderSetup("github")).resolves.toMatchObject({
      clientId: "github-client",
      configured: true,
      provider: "github",
      redirectUri: "https://busy.example.com/api/mcp/oauth/github/callback",
    });
    expect(JSON.stringify(await getProviderSetup("github"))).not.toContain(
      "github-secret"
    );
    await expect(getProviderClient("github")).resolves.toMatchObject({
      clientId: "github-client",
      clientSecret: "github-secret",
      version: saved.version,
    });
  });

  it("binds ciphertext to the provider name", async () => {
    await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    const provider = harness.providerRows.get("github");
    assert(provider);
    const sealed = provider.sealedClient;
    expect(() => decryptOAuth(sealed, "provider:google", secret)).toThrow(
      "Invalid sealed MCP OAuth payload"
    );
  });

  it("invalidates only connections owned by the changed registered provider", async () => {
    await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    expect(harness.connectionRows).toMatchObject([
      {
        catalogId: "github",
        error: "Provider credentials changed. Reconnect this MCP.",
        oauthData: null,
        status: "error",
      },
      {
        catalogId: "google",
        error: null,
        oauthData: "sealed-google",
        status: "connected",
      },
      {
        catalogId: "linear",
        error: null,
        oauthData: "sealed-linear",
        status: "connected",
      },
    ]);
    const firstProvider = harness.providerRows.get("github");
    assert(firstProvider);
    const firstVersion = firstProvider.version;
    const same = await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    expect(same).toEqual({ changed: false, version: firstVersion });
    const [githubConnection] = harness.connectionRows;
    assert(githubConnection);
    expect(githubConnection.status).toBe("error");

    await saveProviderClient("google", {
      clientId: "google-client",
      clientSecret: "google-secret",
    });
    assert(githubConnection.oauthData === null);
    expect(githubConnection.oauthData).toBeNull();
    expect(harness.connectionRows[1]).toMatchObject({
      oauthData: null,
      status: "error",
    });
    expect(harness.connectionRows[2]).toMatchObject({
      oauthData: "sealed-linear",
      status: "connected",
    });
  });

  it("keeps an existing secret when an edit intentionally leaves it blank", async () => {
    await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    const saved = await saveProviderClient("github", {
      clientId: "github-client",
    });
    expect(saved.changed).toBe(false);
    await expect(getProviderClient("github")).resolves.toMatchObject({
      clientId: "github-client",
      clientSecret: "github-secret",
      version: saved.version,
    });
  });

  it("rejects a blank secret when the client ID changes", async () => {
    await saveProviderClient("github", {
      clientId: "github-client",
      clientSecret: "github-secret",
    });
    await expect(
      saveProviderClient("github", { clientId: "another-client" })
    ).rejects.toThrow("Invalid provider credentials");
  });

  it("rejects malformed client credentials before storage", () => {
    expect(
      parseProviderClientInput({ clientId: "", clientSecret: "secret" })
    ).toBeNull();
    expect(
      parseProviderClientInput({ clientId: "client", clientSecret: "" })
    ).toEqual({ clientId: "client", clientSecret: undefined });
    expect(
      parseProviderClientInput({
        clientId: "client",
        clientSecret: "secret",
        extra: "ignored",
      })
    ).toEqual({ clientId: "client", clientSecret: "secret" });
  });
});

describe("provider configuration routes", () => {
  it("returns a safe unconfigured projection", async () => {
    const response = await GET(
      new Request("https://busy.example.com/api/mcp/providers/github"),
      params("github")
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      clientId: null,
      configured: false,
      provider: "github",
      version: null,
    });
  });

  it("validates providers and input without storing secrets in a response", async () => {
    expect(
      (await GET(new Request("https://busy.example.com"), params("unknown")))
        .status
    ).toBe(404);
    const bad = await PUT(
      new Request("https://busy.example.com", {
        body: JSON.stringify({ clientId: "", clientSecret: "" }),
        method: "PUT",
      }),
      params("google")
    );
    expect(bad.status).toBe(400);
    const good = await PUT(
      new Request("https://busy.example.com", {
        body: JSON.stringify({
          clientId: "google-client",
          clientSecret: "google-secret",
        }),
        method: "PUT",
      }),
      params("google")
    );
    expect(good.status).toBe(200);
    const body = await good.json();
    expect(body).toMatchObject({
      changed: true,
      clientId: "google-client",
      configured: true,
      provider: "google",
    });
    expect(JSON.stringify(body)).not.toContain("google-secret");
    const sameWithoutSecret = await PUT(
      new Request("https://busy.example.com", {
        body: JSON.stringify({ clientId: "google-client", clientSecret: "" }),
        method: "PUT",
      }),
      params("google")
    );
    expect(sameWithoutSecret.status).toBe(200);
    expect(await sameWithoutSecret.json()).toMatchObject({
      changed: false,
      clientId: "google-client",
    });
    const changedWithoutSecret = await PUT(
      new Request("https://busy.example.com", {
        body: JSON.stringify({
          clientId: "different-client",
          clientSecret: "",
        }),
        method: "PUT",
      }),
      params("google")
    );
    expect(changedWithoutSecret.status).toBe(400);
  });
});
