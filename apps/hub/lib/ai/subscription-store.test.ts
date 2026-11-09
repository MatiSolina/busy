import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  aiSubscriptionAttempts,
  aiSubscriptionConnections,
  aiSubscriptionHosts,
  appAiSettings,
} from "@/lib/db/schema";
import { decryptOAuth, encryptOAuth } from "@/lib/mcp/crypto";
import {
  SubscriptionConnectionError,
  type SubscriptionCredentials,
} from "./subscription-types";

const schema = {
  aiSubscriptionAttempts,
  aiSubscriptionConnections,
  aiSubscriptionHosts,
  appAiSettings,
};
const protocol = vi.hoisted(() => ({
  finishSubscriptionAuth: vi.fn(),
  listSubscriptionModels: vi.fn(),
  refreshSubscriptionCredentials: vi.fn(),
  startSubscriptionAuth: vi.fn(),
}));

vi.mock("./subscription-protocols", () => protocol);

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let store: typeof import("./subscription-store");

beforeAll(async () => {
  client = new PGlite();
  await client.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("../../drizzle/0015_ai_settings.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("../../drizzle/0016_ai_subscriptions.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
  vi.doMock("@/lib/db", () => ({ ...schema, db: () => database }));
  vi.stubEnv("SESSION_SECRET", "subscription-test-secret-123");
  vi.resetModules();
  store = await import("./subscription-store");
});

beforeEach(async () => {
  vi.clearAllMocks();
  await client.exec(
    "DELETE FROM ai_subscription_attempts; DELETE FROM ai_subscription_connections; DELETE FROM ai_subscription_hosts;"
  );
  protocol.startSubscriptionAuth.mockResolvedValue({
    attempt: {
      clientId: "client",
      deviceCode: "device",
      expiresAt: Date.now() + 60_000,
      hostId: "urn:uuid:test",
      intervalMs: 1000,
      kind: "device",
      provider: "grok",
      userCode: "ABCD",
    },
    public: {
      attemptId: "ignored-by-store",
      expiresAt: Date.now() + 60_000,
      intervalMs: 1000,
      kind: "device",
      provider: "grok",
      url: "https://auth.x.ai/device",
      userCode: "ABCD",
    },
  });
  protocol.finishSubscriptionAuth.mockResolvedValue(null);
  protocol.listSubscriptionModels.mockResolvedValue([
    { id: "grok/grok-4.7", label: "Grok 4.7" },
  ]);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("subscription store", () => {
  const credentials = (expiresAt: number) => ({
    accessToken: "old-access",
    accountId: "acct",
    clientId: "client",
    expiresAt,
    refreshToken: "old-refresh",
  });

  async function insertConnection(
    value = credentials(Date.now() + 60 * 60 * 1000),
    encryptionSecret = "subscription-test-secret-123"
  ) {
    await database.insert(schema.aiSubscriptionConnections).values({
      accountId: value.accountId,
      models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
      provider: "grok",
      sealedCredentials: encryptOAuth(
        value,
        "busy:ai:credentials:grok",
        encryptionSecret
      ),
    });
  }

  it("encrypts attempts, scopes completion to the session user, and persists a connected grant", async () => {
    const started = await store.startConnection("grok", "user-1", {
      now: Date.now(),
    });
    expect(started.attemptId).not.toBe("ignored-by-store");
    const attempts = await database
      .select()
      .from(schema.aiSubscriptionAttempts);
    expect(attempts[0]?.sealedAttempt).not.toContain("device");

    await expect(
      store.completeConnection(
        "grok",
        "other-user",
        { attemptId: started.attemptId },
        { now: Date.now() }
      )
    ).rejects.toThrow("not found");

    await expect(
      store.completeConnection(
        "grok",
        "user-1",
        { attemptId: started.attemptId },
        { now: Date.now() }
      )
    ).resolves.toEqual({ intervalMs: 1000, status: "pending" });
    expect(
      await database.select().from(schema.aiSubscriptionAttempts)
    ).toHaveLength(1);

    protocol.finishSubscriptionAuth.mockResolvedValueOnce({
      accessToken: "access",
      accountId: "acct",
      clientId: "client",
      expiresAt: Date.now() + 60_000,
      refreshToken: "refresh",
    });
    const [pending] = await database
      .select()
      .from(schema.aiSubscriptionAttempts);
    if (!pending) {
      throw new Error("expected pending subscription attempt");
    }
    const connected = await store.completeConnection(
      "grok",
      "user-1",
      { attemptId: pending.id },
      { now: Date.now() + 2000 }
    );
    expect(connected).toEqual({ status: "connected" });
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toHaveLength(1);
    const [receipt] = await database
      .select()
      .from(schema.aiSubscriptionAttempts);
    expect(receipt).toBeTruthy();
  });

  it("disconnects without falling back to a paid provider", async () => {
    await database
      .insert(schema.aiSubscriptionConnections)
      .values({ provider: "grok", sealedCredentials: "sealed" });
    await store.disconnectConnection("grok");
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toEqual([]);
  });

  it("cancels only the owning user's attempt and blocks a later completion", async () => {
    const started = await store.startConnection("grok", "user-1", {
      now: Date.now(),
    });
    await expect(
      store.cancelConnectionAttempt("grok", "other-user", started.attemptId)
    ).rejects.toThrow("not found");
    await expect(
      store.cancelConnectionAttempt("grok", "user-1", started.attemptId)
    ).resolves.toBeUndefined();
    expect(await database.select().from(schema.aiSubscriptionAttempts)).toEqual(
      []
    );
    await expect(
      store.completeConnection("grok", "user-1", {
        attemptId: started.attemptId,
      })
    ).rejects.toThrow("not found");
    expect(protocol.finishSubscriptionAuth).not.toHaveBeenCalled();
  });

  it("persists a terminal failure receipt instead of polling forever", async () => {
    const started = await store.startConnection("grok", "user-1", {
      now: Date.now(),
    });
    protocol.finishSubscriptionAuth.mockRejectedValueOnce(
      new Error("provider declined")
    );
    await expect(
      store.completeConnection("grok", "user-1", {
        attemptId: started.attemptId,
      })
    ).resolves.toEqual({ status: "failed" });
    await expect(
      store.completeConnection("grok", "user-1", {
        attemptId: started.attemptId,
      })
    ).rejects.toThrow("connection failed");
    expect(protocol.finishSubscriptionAuth).toHaveBeenCalledTimes(1);
  });

  it("uses a valid token without refreshing it, then persists one rotated token", async () => {
    const now = Date.now();
    await insertConnection(credentials(now + 60 * 60 * 1000));
    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).resolves.toMatchObject({
      credentials: { accessToken: "old-access" },
    });
    await expect(store.listSubscriptionConnections()).resolves.toEqual([
      {
        accountLabel: "Account acct",
        models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
        provider: "grok",
      },
    ]);
    expect(protocol.refreshSubscriptionCredentials).not.toHaveBeenCalled();

    await database.delete(schema.aiSubscriptionConnections);
    await insertConnection(credentials(now - 1));
    protocol.refreshSubscriptionCredentials.mockResolvedValue({
      accessToken: "new-access",
      accountId: "acct",
      clientId: "client",
      expiresAt: now + 60 * 60 * 1000,
      refreshToken: "new-refresh",
    });
    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).resolves.toMatchObject({
      credentials: { accessToken: "new-access", refreshToken: "new-refresh" },
    });
    expect(protocol.refreshSubscriptionCredentials).toHaveBeenCalledTimes(1);
    const [row] = await database
      .select()
      .from(schema.aiSubscriptionConnections);
    if (!row) {
      throw new Error("expected rotated connection");
    }
    const persisted = decryptOAuth<SubscriptionCredentials>(
      row.sealedCredentials,
      "busy:ai:credentials:grok",
      "subscription-test-secret-123"
    );
    expect(persisted.accessToken).toBe("new-access");
    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).resolves.toMatchObject({
      credentials: { accessToken: "new-access" },
    });
    expect(protocol.refreshSubscriptionCredentials).toHaveBeenCalledTimes(1);
  });

  it("refreshes grants near expiry from the cron, ahead of chat requests", async () => {
    const now = Date.now();
    await insertConnection(credentials(now + 20 * 60 * 1000));
    const stages: Record<string, number> = {};
    await expect(
      store.getSubscriptionAccess("grok", { now, stages })
    ).resolves.toMatchObject({ credentials: { accessToken: "old-access" } });
    expect(protocol.refreshSubscriptionCredentials).not.toHaveBeenCalled();
    expect(stages).not.toHaveProperty("ai.refresh");

    protocol.refreshSubscriptionCredentials.mockResolvedValue({
      ...credentials(now + 60 * 60 * 1000),
      accessToken: "cron-access",
      refreshToken: "cron-refresh",
    });
    await expect(store.refreshExpiringSubscriptions({ now })).resolves.toEqual({
      grok: "ok",
    });
    expect(protocol.refreshSubscriptionCredentials).toHaveBeenCalledTimes(1);
    await expect(
      store.getSubscriptionAccess("grok", { now, stages })
    ).resolves.toMatchObject({ credentials: { accessToken: "cron-access" } });

    await store.refreshExpiringSubscriptions({ now });
    expect(protocol.refreshSubscriptionCredentials).toHaveBeenCalledTimes(1);
  });

  it("reports a failed cron refresh and keeps the grant for the request path", async () => {
    const now = Date.now();
    await insertConnection(credentials(now + 20 * 60 * 1000));
    protocol.refreshSubscriptionCredentials.mockRejectedValue(
      new Error("token endpoint down")
    );
    await expect(store.refreshExpiringSubscriptions({ now })).resolves.toEqual({
      grok: "failed",
    });
    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).resolves.toMatchObject({ credentials: { accessToken: "old-access" } });
  });

  it("times an inline refresh as its own stage", async () => {
    const now = Date.now();
    await insertConnection(credentials(now - 1));
    protocol.refreshSubscriptionCredentials.mockResolvedValue(
      credentials(now + 60 * 60 * 1000)
    );
    const stages: Record<string, number> = {};
    await store.getSubscriptionAccess("grok", { now, stages });
    expect(stages["ai.refresh"]).toEqual(expect.any(Number));
  });

  it("serves valid credentials without opening a locking transaction", async () => {
    const now = Date.now();
    await insertConnection(credentials(now + 60 * 60 * 1000));
    const transaction = vi.spyOn(database, "transaction");
    try {
      await expect(
        store.getSubscriptionAccess("grok", { now })
      ).resolves.toMatchObject({
        credentials: { accessToken: "old-access" },
      });
      expect(transaction).not.toHaveBeenCalled();
    } finally {
      transaction.mockRestore();
    }
  });

  it("keeps the previous sealed grant when refresh fails", async () => {
    const now = Date.now();
    await insertConnection(credentials(now - 1));
    protocol.refreshSubscriptionCredentials.mockRejectedValue(
      new Error("refresh failed")
    );
    await expect(store.getSubscriptionAccess("grok", { now })).rejects.toThrow(
      "refresh failed"
    );
    const [row] = await database
      .select()
      .from(schema.aiSubscriptionConnections);
    if (!row) {
      throw new Error("expected existing connection");
    }
    const persisted = decryptOAuth(
      row.sealedCredentials,
      "busy:ai:credentials:grok",
      "subscription-test-secret-123"
    );
    expect(persisted).toMatchObject({
      accessToken: "old-access",
      refreshToken: "old-refresh",
    });
  });

  it("labels revoked refresh grants as reconnect-required and removes stale connection metadata", async () => {
    const now = Date.now();
    await insertConnection(credentials(now - 1));
    protocol.refreshSubscriptionCredentials.mockRejectedValue(
      new SubscriptionConnectionError(
        "provider returned invalid_grant",
        "connection_expired"
      )
    );
    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).rejects.toMatchObject({
      code: "connection_expired",
    });
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toHaveLength(0);
    await expect(store.listSubscriptionConnections()).resolves.toEqual([]);
  });

  it("labels a grant encrypted by another environment as reconnect-required without deleting it", async () => {
    const now = Date.now();
    await insertConnection(
      credentials(now + 60 * 60 * 1000),
      "another-environment-session-secret-123"
    );

    await expect(
      store.getSubscriptionAccess("grok", { now })
    ).rejects.toMatchObject({ code: "connection_expired" });
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toHaveLength(1);
    await expect(store.listSubscriptionConnections()).resolves.toEqual([]);
    expect(protocol.refreshSubscriptionCredentials).not.toHaveBeenCalled();
  });

  it("invalidates only the exact grant that received an auth failure", async () => {
    const now = Date.now();
    const current = credentials(now + 60 * 60 * 1000);
    await insertConnection(current);
    await expect(
      store.invalidateSubscriptionAccess("grok", {
        ...current,
        accessToken: "newer-access",
      })
    ).resolves.toBe(false);
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toHaveLength(1);
    await expect(
      store.invalidateSubscriptionAccess("grok", current)
    ).resolves.toBe(true);
    expect(
      await database.select().from(schema.aiSubscriptionConnections)
    ).toHaveLength(0);
  });

  it("serializes concurrent expired-token refreshes through the row lock", async () => {
    const now = Date.now();
    await insertConnection(credentials(now - 1));
    let refreshes = 0;
    protocol.refreshSubscriptionCredentials.mockImplementation(async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        accessToken: "rotated-access",
        accountId: "acct",
        clientId: "client",
        expiresAt: now + 60 * 60 * 1000,
        refreshToken: "rotated-refresh",
      };
    });
    const results = await Promise.all([
      store.getSubscriptionAccess("grok", { now }),
      store.getSubscriptionAccess("grok", { now }),
    ]);
    expect(results[0]?.credentials.accessToken).toBe("rotated-access");
    expect(results[1]?.credentials.accessToken).toBe("rotated-access");
    expect(refreshes).toBe(1);
  });
});
