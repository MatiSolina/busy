import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiSubscriptionAttempts,
  aiSubscriptionConnections,
  aiSubscriptionHosts,
  appAiSettings,
} from "./lib/db/schema";

const schema = {
  aiSubscriptionAttempts,
  aiSubscriptionConnections,
  aiSubscriptionHosts,
  appAiSettings,
};

let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  await client.exec(
    readFileSync(
      fileURLToPath(new URL("./drizzle/0015_ai_settings.sql", import.meta.url)),
      "utf8"
    )
  );
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0016_ai_subscriptions.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client, { schema });
});

afterAll(async () => {
  await client.close();
});

describe("subscription storage migration", () => {
  it("accepts subscription providers while keeping browser roles locked out", async () => {
    await database
      .insert(appAiSettings)
      .values({ id: "default", provider: "grok" });
    const settings = await database.select().from(appAiSettings);
    expect(settings).toMatchObject([{ id: "default", provider: "grok" }]);

    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('ai_subscription_hosts', 'ai_subscription_connections', 'ai_subscription_attempts')
      ORDER BY relname
    `);
    expect(rls.rows).toEqual([
      { relname: "ai_subscription_attempts", relrowsecurity: true },
      { relname: "ai_subscription_connections", relrowsecurity: true },
      { relname: "ai_subscription_hosts", relrowsecurity: true },
    ]);
    const grants = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.role_table_grants
      WHERE grantee IN ('anon', 'authenticated')
        AND table_name LIKE 'ai_subscription_%'
    `);
    expect(grants.rows).toEqual([]);
  });

  it("enforces one encrypted connection per provider and one default host", async () => {
    await database
      .insert(aiSubscriptionHosts)
      .values({ hostId: "urn:uuid:test", id: "default" });
    await database.insert(aiSubscriptionConnections).values({
      models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
      provider: "grok",
      sealedCredentials: "sealed",
    });
    await expect(
      database.insert(aiSubscriptionConnections).values({
        provider: "grok",
        sealedCredentials: "other",
      })
    ).rejects.toThrow();
    await expect(
      database
        .insert(aiSubscriptionHosts)
        .values({ hostId: "urn:uuid:other", id: "other" })
    ).rejects.toThrow();
  });
});
