import { PGlite } from "@electric-sql/pglite";
import { eq, type SQL } from "drizzle-orm";
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
import { messages } from "./lib/db/schema";

const mocks = vi.hoisted(() => ({ database: null as unknown }));

vi.mock("@/lib/db", () => ({ db: () => mocks.database, messages }));
vi.mock("@/lib/chat/send", () => ({ sendToBot: vi.fn() }));
vi.mock("@/lib/chat/fast-path", () => ({
  fastPathEnabled: () => false,
  withFastAck: (context: unknown) => context,
  withFastExchanges: (context: unknown) => context,
}));
vi.mock("@/lib/chat/fast-reply", () => ({ pendingFastExchanges: vi.fn() }));
vi.mock("@/lib/files", () => ({ fileForMessage: vi.fn() }));
vi.mock("@/lib/keep-on", () => ({ keepOn: vi.fn() }));
vi.mock("@/lib/library-objects", () => ({ linkFileProvenance: vi.fn() }));
vi.mock("@/lib/live", () => ({ KEEP_ON_MS: 600_000 }));
vi.mock("@/lib/trace", () => ({
  span: (_name: string, fn: () => unknown) => fn(),
}));
vi.mock("@/workflows/sync-turn", () => ({ syncTurnWorkflow: vi.fn() }));
vi.mock("workflow/api", () => ({ start: vi.fn() }));

const botId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
let client: PGlite;
let database: ReturnType<typeof drizzle>;
let markMessageFailed: typeof import("./lib/chat/deliver").markMessageFailed;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE messages (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      client_context jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivery_id text,
      file_ids jsonb NOT NULL DEFAULT '[]',
      payload_hash text,
      status text NOT NULL DEFAULT 'pending',
      text text NOT NULL,
      -- Columns the merged schema also maps (0020 and 0026).
      selected_skills jsonb NOT NULL DEFAULT '[]',
      session_id text,
      attempt integer NOT NULL DEFAULT 0,
      failure text,
      check_after timestamptz,
      checks integer NOT NULL DEFAULT 0
    );
  `);
  database = drizzle(client);
  mocks.database = database;
  ({ markMessageFailed } = await import("./lib/chat/deliver"));
});

beforeEach(async () => {
  mocks.database = database;
  await client.exec("DELETE FROM messages;");
  await database.insert(messages).values({
    botId,
    id: messageId,
    text: "hello",
  });
});

afterAll(async () => {
  await client.close();
});

describe("message failure CAS", () => {
  it("never degrades an accepted receipt after a concurrent failure observation", async () => {
    await database
      .update(messages)
      .set({ deliveryId: "receipt", status: "accepted" })
      .where(eq(messages.id, messageId));

    await markMessageFailed(messageId, new Error("late worker failure"));

    const [row] = await database
      .select({ deliveryId: messages.deliveryId, status: messages.status })
      .from(messages);
    expect(row).toEqual({ deliveryId: "receipt", status: "accepted" });
  });

  it("checks acceptance atomically when it arrives immediately before the failure update", async () => {
    mocks.database = {
      select: database.select.bind(database),
      update: (table: typeof messages) => ({
        set: (patch: Partial<typeof messages.$inferInsert>) => ({
          where: async (condition: SQL) => {
            // The other worker commits after any prior failure observation,
            // at the last boundary before the delayed failure reaches SQL.
            await database
              .update(messages)
              .set({ deliveryId: "concurrent-receipt", status: "accepted" })
              .where(eq(messages.id, messageId));
            return database.update(table).set(patch).where(condition);
          },
        }),
      }),
    };

    await markMessageFailed(messageId, new Error("delayed failure"));

    const [row] = await database
      .select({ deliveryId: messages.deliveryId, status: messages.status })
      .from(messages);
    expect(row).toEqual({
      deliveryId: "concurrent-receipt",
      status: "accepted",
    });
  });

  it("allows a failed pending row to become accepted without a later failure overwrite", async () => {
    await markMessageFailed(messageId, new Error("definitive failure"));
    await database
      .update(messages)
      .set({ deliveryId: "retry-receipt", status: "accepted" })
      .where(eq(messages.id, messageId));
    await markMessageFailed(messageId, new Error("stale failure"));

    const [row] = await database
      .select({ deliveryId: messages.deliveryId, status: messages.status })
      .from(messages);
    expect(row).toEqual({ deliveryId: "retry-receipt", status: "accepted" });
  });
});
