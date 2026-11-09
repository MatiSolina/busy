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
import { appAiSettings } from "@/lib/db/schema";
import type {
  SubscriptionModel,
  SubscriptionProvider,
} from "./subscription-types";

const connections = vi.hoisted(() => ({
  items: [] as {
    provider: SubscriptionProvider;
    models: SubscriptionModel[];
    accountLabel: string | null;
  }[],
}));
vi.mock("./subscription-store", () => ({
  listSubscriptionConnections: async () => connections.items,
}));

const schema = { appAiSettings };
let client: PGlite;
let database: ReturnType<typeof drizzle<typeof schema>>;
let settings: typeof import("./settings");

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
  vi.doMock("@/lib/db", () => ({
    appAiSettings: schema.appAiSettings,
    db: () => database,
  }));
  vi.resetModules();
  settings = await import("./settings");
});

beforeEach(async () => {
  connections.items = [];
  await client.exec("DELETE FROM app_ai_settings;");
});

afterAll(async () => {
  await client.close();
});

describe("AI settings persistence", () => {
  it("starts unconfigured and blocks new bots until a provider is configured", async () => {
    await expect(settings.getAiSettings({})).resolves.toMatchObject({
      onboardingCompleted: false,
      provider: null,
    });
    await expect(settings.getDefaultAiBilling({})).rejects.toThrow(
      "Token Pass is not configured for this Busy account."
    );
  });

  it("allows the legacy Token Pass default once its key is configured", async () => {
    await expect(
      settings.getDefaultAiBilling({ TOKEN_PASS_API_KEY: "configured" })
    ).resolves.toBe("token-pass");
  });

  it("saves a supported provider and marks onboarding complete", async () => {
    await expect(settings.saveAiSettings("gateway", {})).resolves.toMatchObject(
      {
        onboardingCompleted: true,
        provider: "gateway",
      }
    );
    await expect(settings.getDefaultAiBilling({})).resolves.toBe("gateway");

    const rows = await database.select().from(schema.appAiSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("default");
  });

  it("keeps the previous provider when a replacement is unavailable", async () => {
    await settings.saveAiSettings("gateway", {});

    await expect(settings.saveAiSettings("token-pass", {})).rejects.toThrow(
      "Token Pass is not configured"
    );
    await expect(settings.getDefaultAiBilling({})).resolves.toBe("gateway");
  });

  it("rejects unconfigured Token Pass and subscriptions without a completed grant", async () => {
    await expect(settings.saveAiSettings("token-pass", {})).rejects.toThrow(
      "Token Pass is not configured"
    );
    await expect(
      settings.saveAiSettings("chatgpt" as never, { TOKEN_PASS_API_KEY: "key" })
    ).rejects.toThrow("Connect your subscription");
    await expect(
      settings.saveAiSettings("grok" as never, { TOKEN_PASS_API_KEY: "key" })
    ).rejects.toThrow("Connect your subscription");
    await expect(database.select().from(schema.appAiSettings)).resolves.toEqual(
      []
    );
  });

  it("enforces the singleton and provider constraints in the database", async () => {
    await expect(
      client.exec(
        "INSERT INTO app_ai_settings (id, provider) VALUES ('other', 'gateway');"
      )
    ).rejects.toThrow();
    await expect(
      client.exec(
        "INSERT INTO app_ai_settings (id, provider) VALUES ('default', 'unknown-provider');"
      )
    ).rejects.toThrow();
  });

  it("requires an account model, persists it, and prevents fallback after disconnect", async () => {
    connections.items = [
      {
        accountLabel: null,
        models: [{ id: "grok/grok-4.7", label: "Grok 4.7" }],
        provider: "grok",
      },
    ];
    await expect(
      settings.saveAiSettings("grok", {}, "chatgpt/gpt-6.1-sol")
    ).rejects.toThrow("Choose an available subscription model");
    await expect(
      settings.saveAiSettings("grok", {}, "grok/grok-4.7")
    ).resolves.toMatchObject({
      model: "grok/grok-4.7",
      onboardingCompleted: true,
      provider: "grok",
    });
    await expect(settings.getDefaultAiSelection({})).resolves.toEqual({
      billing: "grok",
      model: "grok/grok-4.7",
    });
    connections.items = [];
    await expect(settings.getDefaultAiSelection({})).rejects.toThrow(
      "Reconnect your subscription"
    );
  });

  it("keeps the settings table private and safely reapplies its migration", async () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL("../../drizzle/0015_ai_settings.sql", import.meta.url)
      ),
      "utf8"
    );
    await client.exec(migration);

    const rls = await client.query<{ enabled: boolean }>(`
      SELECT relrowsecurity AS enabled
      FROM pg_class
      WHERE relname = 'app_ai_settings'
    `);
    const privileges = await client.query<{ can_read: boolean }>(`
      SELECT has_table_privilege('anon', 'public.app_ai_settings', 'SELECT') AS can_read
    `);

    expect(rls.rows).toEqual([{ enabled: true }]);
    expect(privileges.rows).toEqual([{ can_read: false }]);
  });
});
