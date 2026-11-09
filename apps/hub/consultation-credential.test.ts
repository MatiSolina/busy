import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { decodeJwt, importJWK, type JWK, jwtVerify } from "jose";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
// biome-ignore lint/performance/noNamespaceImport: Drizzle tests pass the complete schema map to the database client.
import * as schema from "./lib/db/schema";
import {
  CONSULTATION_AUDIENCE_PREFIX,
  HUB_ISSUER,
  hubPublicKey,
  signConsultationToken,
  signHubToken,
} from "./lib/hub-token";
import { verifyBotRequest } from "./lib/oidc";

// H-26: the hub mints a consultation credential scoped to one asking bot and one consulted bot.

const h = vi.hoisted(() => ({ caller: "alice", db: vi.fn() }));
vi.mock("./lib/db", () => ({
  bots: schema.bots,
  consultations: schema.consultations,
  cursors: schema.cursors,
  db: h.db,
  events: schema.events,
}));
vi.mock("./lib/bot-auth", () => ({
  botFromRequest: async () =>
    h.caller
      ? { slug: h.caller }
      : new Response("unauthorized", { status: 401 }),
}));

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const CAROL = "00000000-0000-4000-8000-00000000000c";
const DRAFT = "00000000-0000-4000-8000-00000000000d";

const RAW = JSON.stringify(
  generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({
    format: "jwk",
  })
);
const publicKey = () =>
  importJWK(JSON.parse(hubPublicKey(RAW)) as JWK, "ES256");

let client: PGlite;

async function post(body: unknown) {
  const { POST } = await import("./app/api/bot/consultations/credential/route");
  return POST(
    new Request("https://hub.example.com/api/bot/consultations/credential", {
      body: JSON.stringify(body),
      method: "POST",
    })
  );
}

beforeAll(async () => {
  vi.stubEnv("HUB_SIGNING_KEY", RAW);
  client = new PGlite();
  await client.exec(`
    CREATE TABLE bots (
      id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, status text NOT NULL,
      created_at timestamptz NOT NULL, deletion_state text
    );
  `);
  await client.query(
    `INSERT INTO bots (id, slug, status, created_at) VALUES
      ($1, 'alice', 'ready', '2026-11-08T10:00:00Z'),
      ($2, 'bob', 'ready', '2026-11-08T10:01:00Z'),
      ($3, 'carol', 'ready', '2026-11-08T10:02:00Z'),
      ($4, 'draft', 'creating', '2026-11-08T10:03:00Z')`,
    [ALICE, BOB, CAROL, DRAFT]
  );
  h.db.mockReturnValue(drizzle(client, { schema }));
});

beforeEach(() => {
  h.caller = "alice";
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await client.close();
});

describe("consultation credential endpoint", () => {
  it("mints a short credential for the authenticated caller and the named peer only", async () => {
    const res = await post({ to: BOB });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      expiresAt: number;
      to: string;
      token: string;
    };
    expect(body.to).toBe(BOB);
    const { payload } = await jwtVerify(body.token, await publicKey(), {
      audience: `${CONSULTATION_AUDIENCE_PREFIX}bob`,
      issuer: HUB_ISSUER,
    });
    expect(payload).toMatchObject({
      busy_purpose: "consultation",
      from_bot: ALICE,
      from_slug: "alice",
      sub: `consultation:${ALICE}:${BOB}`,
      to_bot: BOB,
    });
    expect(typeof payload.jti).toBe("string");
    expect(Number(payload.exp) - Number(payload.iat)).toBe(300);
    expect(body.expiresAt).toBe(Number(payload.exp) * 1000);
  });

  it("ignores identity fields in the body: the subject is always the authenticated caller", async () => {
    const res = await post({ from: CAROL, sub: "hub", to: BOB });
    const { token } = (await res.json()) as { token: string };
    expect(decodeJwt(token).sub).toBe(`consultation:${ALICE}:${BOB}`);
  });

  it.each([
    ["itself", ALICE, 403],
    ["a bot that is not ready", DRAFT, 403],
    ["an unknown bot", "00000000-0000-4000-8000-0000000000ff", 403],
  ])("refuses %s as destination", async (_, to, status) => {
    expect((await post({ to })).status).toBe(status);
  });

  it("refuses a malformed body, an unknown caller and a missing OIDC identity", async () => {
    expect((await post({ to: "bob" })).status).toBe(400);
    h.caller = "ghost";
    expect((await post({ to: BOB })).status).toBe(404);
    h.caller = "";
    expect((await post({ to: BOB })).status).toBe(401);
  });
});

describe("consultation credential scope", () => {
  it("is refused as a hub token by the consulted bot, and as a token for another bot", async () => {
    const { token } = await signConsultationToken(
      { id: ALICE, slug: "alice" },
      { id: BOB, slug: "bob" },
      RAW
    );
    const key = await publicKey();
    // The hub→bot verifier on Bob and Carol uses aud = slug.
    for (const audience of [
      "bob",
      "carol",
      `${CONSULTATION_AUDIENCE_PREFIX}carol`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each audience is an independent refusal
      await expect(
        jwtVerify(token, key, { audience, issuer: HUB_ISSUER })
      ).rejects.toThrow();
    }
    // And a hub→bot token is no consultation credential.
    const hub = await signHubToken("bob", RAW);
    await expect(
      jwtVerify(hub, key, {
        audience: `${CONSULTATION_AUDIENCE_PREFIX}bob`,
        issuer: HUB_ISSUER,
      })
    ).rejects.toThrow();
  });

  it("is refused by the hub's /api/bot/* authentication", async () => {
    const { token } = await signConsultationToken(
      { id: ALICE, slug: "alice" },
      { id: BOB, slug: "bob" },
      RAW
    );
    // Even if the hub key were served as the team JWKS, issuer and audience don't match.
    const key = await publicKey();
    await expect(
      verifyBotRequest(
        new Request("https://hub.example.com/api/bot/memory", {
          headers: { authorization: `Bearer ${token}` },
        }),
        { jwks: async () => key, team: "mati-solina" }
      )
    ).rejects.toThrow();
  });

  it("expires after five minutes", async () => {
    const issued = Date.now() - 6 * 60 * 1000;
    const { token } = await signConsultationToken(
      { id: ALICE, slug: "alice" },
      { id: BOB, slug: "bob" },
      RAW,
      issued
    );
    await expect(
      jwtVerify(token, await publicKey(), {
        audience: `${CONSULTATION_AUDIENCE_PREFIX}bob`,
        issuer: HUB_ISSUER,
      })
    ).rejects.toThrow();
  });

  it("refuses to mint for the same bot or a non-id", async () => {
    await expect(
      signConsultationToken(
        { id: ALICE, slug: "alice" },
        { id: ALICE, slug: "alice" },
        RAW
      )
    ).rejects.toThrow();
    await expect(
      signConsultationToken(
        { id: "alice", slug: "alice" },
        { id: BOB, slug: "bob" },
        RAW
      )
    ).rejects.toThrow();
  });
});
