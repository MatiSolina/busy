import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const botId = "11111111-1111-4111-8111-111111111111";
const messageId = "22222222-2222-4222-8222-222222222222";
let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE TABLE bots (id uuid PRIMARY KEY);
    CREATE TABLE messages (id uuid PRIMARY KEY, bot_id uuid NOT NULL);
  `);
  await client.exec(
    readFileSync(
      fileURLToPath(
        new URL("./drizzle/0025_session_recovery.sql", import.meta.url)
      ),
      "utf8"
    )
  );
  await client.exec(
    `INSERT INTO bots (id) VALUES ('${botId}'); INSERT INTO messages (id, bot_id) VALUES ('${messageId}', '${botId}');`
  );
});

afterAll(async () => {
  await client.close();
});

describe("session recovery persistence", () => {
  it("allows one active recovery per bot and preserves accepted attempts", async () => {
    await client.exec(`
      INSERT INTO session_recoveries (bot_id, message_id, operation_id, packet)
      VALUES ('${botId}', '${messageId}', 'recovery-1', '{"version":1}');
    `);
    await expect(
      client.exec(`
        INSERT INTO session_recoveries (bot_id, message_id, operation_id, packet)
        VALUES ('${botId}', '${messageId}', 'recovery-2', '{"version":1}');
      `)
    ).rejects.toThrow();

    await client.exec(`
      INSERT INTO message_delivery_attempts (bot_id, message_id, operation_id, session_id, state)
      VALUES ('${botId}', '${messageId}', 'message-1', 'session-1', 'sending');
      UPDATE message_delivery_attempts
      SET delivery_id = 'delivery-1', state = 'accepted'
      WHERE operation_id = 'message-1' AND state = 'sending';
    `);
    const result = await client.query<{ state: string; delivery_id: string }>(
      "SELECT state, delivery_id FROM message_delivery_attempts WHERE operation_id = 'message-1'"
    );
    expect(result.rows).toEqual([
      { delivery_id: "delivery-1", state: "accepted" },
    ]);
    const stale = await client.query(
      "UPDATE message_delivery_attempts SET state = 'failed' WHERE operation_id = 'message-1' AND state = 'sending'"
    );
    expect(stale.affectedRows).toBe(0);
  });
});
