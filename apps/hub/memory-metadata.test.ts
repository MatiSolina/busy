import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listMemoryMetadata,
  listMemoryMetadataEvents,
  type MemorySource,
  syncMemoryMetadata,
} from "@/lib/memory-metadata";

const BOT_ID = "11111111-1111-4111-8111-111111111111";
const BOT = "assistant";
const owner: MemorySource = {
  author: "mati",
  messageId: null,
  origin: "owner",
  sessionId: null,
  sourceStatus: "trusted_user",
  turnId: null,
};

let client: PGlite;
let database: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (
      id uuid PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      name text NOT NULL DEFAULT 'Assistant'
    );
    CREATE TABLE memories (
      bot_slug text PRIMARY KEY,
      content text NOT NULL,
      version integer NOT NULL
    );
    INSERT INTO bots (id, slug) VALUES ('${BOT_ID}', '${BOT}');
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0017_memory_metadata.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  database = drizzle(client);
});

beforeEach(async () => {
  await client.exec(
    "DELETE FROM memory_metadata_events; DELETE FROM memory_metadata;"
  );
});

afterAll(async () => {
  await client.close();
});

describe("memory metadata provenance", () => {
  it("records additions and keeps unchanged provenance on reconciliation", async () => {
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content:
        "<!-- eve-memory-file-v1 lastAllocatedIndex=1 -->\n0: Prefers Excel\n1: Uses pesos\n",
      documentVersion: 1,
      previousContent: null,
      source: owner,
    });

    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content:
        "<!-- eve-memory-file-v1 lastAllocatedIndex=1 -->\n0: Prefers Excel\n1: Uses pesos\n",
      documentVersion: 2,
      previousContent:
        "<!-- eve-memory-file-v1 lastAllocatedIndex=1 -->\n0: Prefers Excel\n1: Uses pesos\n",
      source: {
        author: "bot:assistant",
        origin: "bot",
        sourceStatus: "bot_identity_only",
      },
    });

    const rows = await listMemoryMetadata(database, BOT);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.entryId === "0")).toMatchObject({
      author: "mati",
      origin: "owner",
      sourceStatus: "trusted_user",
    });
    expect(await listMemoryMetadataEvents(database, BOT)).toHaveLength(2);
  });

  it("attributes a changed document to a verified Eve turn and records the diff", async () => {
    const first =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: Prefers Excel\n";
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: first,
      documentVersion: 1,
      previousContent: null,
      source: owner,
    });
    const second =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: Prefers Google Sheets\n";
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: second,
      documentVersion: 2,
      previousContent: first,
      source: {
        author: "bot:assistant",
        origin: "bot",
        sessionId: "session-1",
        sourceStatus: "trusted_eve_turn",
        turnId: "turn-1",
      },
    });

    const [row] = await listMemoryMetadata(database, BOT);
    expect(row).toMatchObject({
      author: "bot:assistant",
      messageId: null,
      sessionId: "session-1",
      sourceStatus: "trusted_eve_turn",
      text: "Prefers Google Sheets",
      turnId: "turn-1",
    });
    await expect(listMemoryMetadataEvents(database, BOT)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "updated",
          beforeText: "Prefers Excel",
          documentVersion: 2,
          turnId: "turn-1",
        }),
      ])
    );
  });

  it("attributes only entries changed by the bot turn", async () => {
    const first =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=1 -->\n0: Owner fact\n1: Keep owner source\n";
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: first,
      documentVersion: 1,
      previousContent: null,
      source: owner,
    });
    const changed =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=1 -->\n0: Bot fact\n1: Keep owner source\n";
    const botSource: MemorySource = {
      author: "bot:assistant",
      origin: "bot",
      sourceStatus: "bot_identity_only",
    };
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: changed,
      documentVersion: 2,
      previousContent: first,
      source: botSource,
    });
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: changed,
      documentVersion: 2,
      previousContent: changed,
      source: {
        ...botSource,
        sessionId: "session-1",
        sourceStatus: "trusted_eve_turn",
        turnId: "turn-1",
      },
    });

    const rows = await listMemoryMetadata(database, BOT);
    expect(rows.find((row) => row.entryId === "0")).toMatchObject({
      sourceStatus: "trusted_eve_turn",
      text: "Bot fact",
    });
    expect(rows.find((row) => row.entryId === "1")).toMatchObject({
      author: "mati",
      sourceStatus: "trusted_user",
      text: "Keep owner source",
    });

    // Once a trusted turn has consumed the bot-only provenance, a later
    // unchanged turn must not rewrite its attribution or append another
    // audit event.
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: changed,
      documentVersion: 2,
      previousContent: changed,
      source: {
        ...botSource,
        sessionId: "session-2",
        sourceStatus: "trusted_eve_turn",
        turnId: "turn-2",
      },
    });
    const [unchanged] = (await listMemoryMetadata(database, BOT)).filter(
      (row) => row.entryId === "0"
    );
    expect(unchanged).toMatchObject({
      sessionId: "session-1",
      sourceStatus: "trusted_eve_turn",
      turnId: "turn-1",
    });
    const events = await listMemoryMetadataEvents(database, BOT);
    expect(
      events.filter((event) => event.action === "attributed")
    ).toHaveLength(1);
  });

  it("marks pre-migration entries as legacy without inventing a date or source", async () => {
    const content =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: Existing fact\n";
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content,
      documentVersion: 7,
      previousContent: content,
      source: owner,
    });
    const [row] = await listMemoryMetadata(database, BOT);
    expect(row).toMatchObject({
      author: null,
      createdAt: null,
      origin: "legacy",
      sourceStatus: "legacy",
    });
    expect(await listMemoryMetadataEvents(database, BOT)).toEqual([]);
  });

  it("keeps the audit trail when an entry is removed", async () => {
    const content =
      "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n0: Remove me\n";
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content,
      documentVersion: 1,
      previousContent: null,
      source: owner,
    });
    await syncMemoryMetadata(database, {
      botSlug: BOT,
      content: "<!-- eve-memory-file-v1 lastAllocatedIndex=0 -->\n",
      documentVersion: 2,
      previousContent: content,
      source: owner,
    });
    expect(await listMemoryMetadata(database, BOT)).toEqual([]);
    await expect(listMemoryMetadataEvents(database, BOT)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "removed",
          beforeText: "Remove me",
          documentVersion: 2,
        }),
      ])
    );
  });

  it("keeps the metadata tables private and RLS enabled", async () => {
    const rls = await client.query<{
      relname: string;
      relrowsecurity: boolean;
    }>(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relname IN ('memory_metadata', 'memory_metadata_events')
      ORDER BY relname
    `);
    expect(rls.rows).toEqual([
      { relname: "memory_metadata", relrowsecurity: true },
      { relname: "memory_metadata_events", relrowsecurity: true },
    ]);
    const grants = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.role_table_grants
      WHERE grantee IN ('anon', 'authenticated')
        AND table_name IN ('memory_metadata', 'memory_metadata_events')
    `);
    expect(grants.rows).toEqual([]);
  });
});
