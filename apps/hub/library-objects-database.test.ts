import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let client: PGlite;

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE library_objects (
      id uuid PRIMARY KEY,
      sha256 text NOT NULL UNIQUE CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      pathname text NOT NULL UNIQUE,
      content_type text NOT NULL,
      size integer NOT NULL CHECK (size >= 0),
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY,
      bot_id uuid NOT NULL,
      object_id uuid REFERENCES library_objects(id) ON DELETE RESTRICT,
      pathname text NOT NULL,
      status text NOT NULL DEFAULT 'ready'
    );
  `);
});

afterAll(async () => {
  await client.close();
});

describe("content-addressed object contract", () => {
  it("allows many authorized references to one object and rejects a second digest owner", async () => {
    const digest = "a".repeat(64);
    const objectId = "11111111-1111-4111-8111-111111111111";
    await client.query(
      `INSERT INTO library_objects (id, sha256, pathname, content_type, size, status)
       VALUES ($1, $2, $3, $4, $5, 'ready')`,
      [objectId, digest, `library/sha256/aa/${digest}`, "text/plain", 4]
    );
    await expect(
      client.query(
        `INSERT INTO library_objects (id, sha256, pathname, content_type, size)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          "22222222-2222-4222-8222-222222222222",
          digest,
          "library/sha256/aa/duplicate",
          "text/plain",
          4,
        ]
      )
    ).rejects.toThrow();

    await client.query(
      `INSERT INTO files (id, bot_id, object_id, pathname)
       VALUES ($1, $2, $3, $4), ($5, $6, $3, $4)`,
      [
        "33333333-3333-4333-8333-333333333333",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        objectId,
        `library/sha256/aa/${digest}`,
        "44444444-4444-4444-8444-444444444444",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ]
    );
    const refs = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM files WHERE object_id = $1",
      [objectId]
    );
    expect(refs.rows[0]?.count).toBe("2");
  });

  it("prevents deleting a shared object while a reference remains", async () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    await expect(
      client.query("DELETE FROM library_objects WHERE id = $1", [objectId])
    ).rejects.toThrow();
  });
});
